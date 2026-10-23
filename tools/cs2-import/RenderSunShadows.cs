using System.IO.Compression;
using System.Text.Json.Nodes;
using ValveKeyValue;
using VMaterial = ValveResourceFormat.ResourceTypes.Material;
using ValveResourceFormat.Blocks;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;

// Display-only sunlight visibility. Keep original BC4 blocks and native UV precision.
internal static class RenderSunShadows
{
    public static JsonObject Export(World world, GameFileLoader loader, string folder)
    {
        var info = world.GetWorldLightingInfo();
        if (info.GetInt32Property("m_nLightmapVersionNumber") != 8 ||
            info.GetInt32Property("m_nLightmapGameVersionNumber") != 2 ||
            !info.GetBooleanProperty("m_bHasLightmaps") || info.GetBooleanProperty("m_bBakedShadowsGamma20"))
            throw new InvalidDataException("Unsupported sunlight lightmap version/gamma");
        var suns = new List<EntityLump.Entity>();
        var visited = new HashSet<string>();
        void Entities(string name) {
            if (!visited.Add(name)) return;
            using var resource = loader.LoadFileCompiled(name)!;
            var lump = (EntityLump)resource.DataBlock!;
            suns.AddRange(lump.GetEntities().Where(e => e.GetStringProperty("classname") == "light_environment"));
            foreach (var child in lump.GetChildEntityNames()) Entities(child);
        }
        foreach (var name in world.GetEntityLumpNames()) Entities(name);
        if (suns.Count != 1) throw new InvalidDataException("Expected exactly one baked sun");
        var sun = suns[0];
        var hash = sun.GetUInt32Property("light_path_uniqueid");
        var binding = info.GetArray("m_bakedShadows").Single(b => b.GetUInt32Property("m_nLightHash") == hash);
        if (binding.GetInt32Property("m_nShadowChannel") != 0 || sun.GetInt32Property("bakedshadowindex") != 0)
            throw new InvalidDataException("Only sun channel zero is supported");
        var path = info.GetArray<string>("m_lightMaps").Single(p => p.EndsWith("/direct_light_shadows.vtex"));
        using var textureResource = loader.LoadFileCompiled(path)!;
        var texture = (Texture)textureResource.DataBlock!;
        if (texture.Format.ToString() != "ATI2N" || texture.Depth != 1 || texture.Width % 4 != 0 || texture.Height % 4 != 0)
            throw new InvalidDataException("Expected one BC5U sunlight atlas slice");
        var bc5 = new byte[texture.CalculateBufferSizeForMipLevel(0)];
        texture.ReadTextureMipLevel(bc5, 0);
        var bc4 = RenderSunBlocks.ExtractRed(bc5);
        const string file = "sun-shadow.bc4.gz";
        using (var stream = File.Create(Path.Combine(folder, file)))
        using (var gzip = new GZipStream(stream, CompressionLevel.SmallestSize)) gzip.Write(bc4);
        var scale = world.GetLightmapUvScale();
        return new JsonObject {
            ["schema"] = 1, ["file"] = "render/" + file, ["format"] = "BC4_UNORM", ["width"] = texture.Width,
            ["height"] = texture.Height, ["gpuBytes"] = bc4.Length, ["bytes"] = new FileInfo(Path.Combine(folder, file)).Length,
            ["uvScale"] = new JsonArray(scale.X, scale.Y), ["slice"] = 0, ["channel"] = 0,
            ["gamma20"] = false, ["visibility"] = "1-r", ["flipY"] = false, ["lightHash"] = hash,
        };
    }

    public static void Bind(WorldNode node, JsonObject gltf, GameFileLoader loader)
    {
        // Mirror only the pinned exporter's naming/draw ordering. Assert correspondence;
        // material names alone cannot establish per-draw lighting or UV channels.
        var bindings = new Dictionary<string, (Mesh Mesh, KVObject[] Draws)>();
        var resources = new List<ValveResourceFormat.Resource>();
        ValveResourceFormat.Resource Load(string name) {
            var resource = loader.LoadFileCompiled(name) ?? throw new InvalidDataException("Missing lighting source " + name);
            resources.Add(resource); return resource;
        }
        IEnumerable<(Mesh Mesh, string Name)> Meshes(Model model, string name, bool aggregate) {
            var embedded = aggregate ? model.GetEmbeddedMeshesAndLoD() : model.GetEmbeddedMeshesForLod(model.LodInfo.LowestLevel);
            foreach (var m in embedded) yield return (m.Mesh, name + "." + m.Name);
            if (aggregate && embedded.Any()) yield break;
            foreach (var m in model.GetReferenceMeshNamesForLod(model.LodInfo.LowestLevel))
                yield return ((Mesh)Load(m.MeshName).DataBlock!, Path.GetFileNameWithoutExtension(m.MeshName));
        }
        try {
            foreach (var (item, aggregate) in node.SceneObjects.Select(s => (s, false)).Concat(node.AggregateSceneObjects.Select(s => (s, true)))) {
                var path = item.GetStringProperty("m_renderableModel");
                if (path == null) continue;
                var model = (Model)Load(path).DataBlock!;
                var name = Path.GetFileNameWithoutExtension(path);
                var meshes = Meshes(model, name, aggregate).ToArray();
                if (aggregate && meshes.Length != 1) throw new InvalidDataException("Ambiguous aggregate lighting mesh");
                foreach (var (mesh, meshName) in meshes) {
                    var draws = mesh.Data.GetArray("m_sceneObjects").SelectMany(s => s.GetArray("m_drawCalls")).ToArray();
                    if (aggregate) {
                        var fragments = item.GetArray("m_aggregateMeshes");
                        for (var f = 0; f < fragments.Count; f++)
                            bindings.TryAdd($"{name}_fragment{f + 1}", (mesh, [draws[fragments[f].GetInt32Property("m_nDrawCallIndex")]]));
                    } else bindings.TryAdd(meshName, (mesh, draws));
                }
            }
            var signatures = new Dictionary<string, VMaterial.VsInputSignature>();
            foreach (var m in gltf["meshes"]!.AsArray()) {
                var name = m!["name"]!.GetValue<string>();
                if (!bindings.TryGetValue(name, out var source)) throw new InvalidDataException("Missing lighting binding " + name);
                var primitives = m["primitives"]!.AsArray();
                if (primitives.Count != source.Draws.Length) throw new InvalidDataException("Lighting draw count mismatch " + name);
                for (var i = 0; i < primitives.Count; i++) {
                    var primitive = primitives[i]!;
                    var draw = source.Draws[i];
                    var materialPath = draw.GetStringProperty("m_material") ?? draw.GetStringProperty("m_pMaterial");
                    var exportedName = gltf["materials"]![primitive["material"]!.GetValue<int>()]!["name"]!.GetValue<string>();
                    if (exportedName != Path.GetFileNameWithoutExtension(materialPath)) throw new InvalidDataException("Lighting material mismatch " + name);
                    var mode = Mesh.HasBakedLightingFromLightMap(draw) ? "lightmap" : Mesh.HasBakedLightingFromVertexStream(draw) ? "vertex" : "probe";
                    var binding = new JsonObject { ["mode"] = mode };
                    if (mode == "lightmap") {
                        if (!signatures.TryGetValue(materialPath, out var signature)) {
                            signature = ((VMaterial)Load(materialPath).DataBlock!).InputSignature;
                            signatures.Add(materialPath, signature);
                        }
                        var counter = 0; string? channel = null; string? semantic = null;
                        foreach (var buffer in draw.GetArray("m_vertexBuffers"))
                        foreach (var field in source.Mesh.VBIB.VertexBuffers[buffer.GetInt32Property("m_hBuffer")].InputLayoutFields.OrderBy(f => f.SemanticIndex).ThenBy(f => f.Offset)) {
                            if (field.SemanticName != "TEXCOORD" || VBIB.GetFormatInfo(field).ElementCount != 2) continue;
                            var key = "TEXCOORD_" + counter++;
                            if (VMaterial.FindD3DInputSignatureElement(signature, field.SemanticName, field.SemanticIndex).Name is not ("vLightmapUV" or "vLightmapUVW")) continue;
                            if (channel != null || field.Format.ToString() != "R16G16_UNORM") throw new InvalidDataException("Unsupported sunlight UV layout " + name);
                            channel = key; semantic = "TEXCOORD" + field.SemanticIndex;
                        }
                        if (channel == null || primitive["attributes"]?[channel] == null) throw new InvalidDataException("Missing sunlight UV " + name);
                        binding["attribute"] = channel; binding["semantic"] = semantic; binding["storage"] = "UNORM16x2";
                    }
                    primitive["extras"] = new JsonObject { ["cs2Lighting"] = binding };
                }
            }
        } finally { foreach (var resource in resources) resource.Dispose(); }
    }
}
