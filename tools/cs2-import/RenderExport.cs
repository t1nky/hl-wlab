using System.Diagnostics;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SkiaSharp;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using VMaterial = ValveResourceFormat.ResourceTypes.Material;

// Render data never supplies bullet or player collision. All derived content stays in .local.
internal static class RenderExport
{
    private const int TextureSize = 512;
    private sealed record TextureInfo(string File, int Width, int Height, long Bytes);
    private sealed record MaterialInfo(string Path, string? Texture, bool KeepAlpha);
    private sealed class Reporter : IProgress<string>
    {
        public void Report(string value) { /* Per-mesh VRF progress is too noisy; report per chunk below. */ }
    }

    // Preserve VRF's material interpretation, mesh attributes and placement, but prevent its
    // asynchronous uncapped full-resolution decoding. We decode selected mips sequentially below.
    private sealed class RenderLoader(Package package, string path) : GameFileLoader(package, path)
    {
        public Dictionary<string, MaterialInfo> Materials { get; } = new(StringComparer.Ordinal);
        private readonly List<Resource> resources = [];
        public override Resource? LoadFile(string file)
        {
            var resource = base.LoadFile(file);
            if (resource == null) return null;
            resources.Add(resource);
            if (resource.DataBlock is VMaterial material)
            {
                var color = new[] { "g_tColor", "g_tColor0", "g_tColor1", "g_tColorA", "g_tAlbedo", "g_tBaseColor" }
                    .Select(key => material.TextureParams.GetValueOrDefault(key)).FirstOrDefault(value => value != null);
                var alpha = material.IntParams.GetValueOrDefault("F_TRANSLUCENT") > 0 ||
                    material.IntParams.GetValueOrDefault("F_ALPHA_TEST") > 0 || material.ShaderName.Contains("glass");
                var key = Path.GetFileNameWithoutExtension(file.EndsWith("_c") ? file[..^2] : file);
                var info = new MaterialInfo(file, color, alpha);
                if (Materials.TryGetValue(key, out var prior) && (prior.Texture != color || prior.KeepAlpha != alpha))
                    throw new InvalidDataException("Ambiguous render material basename: " + key);
                Materials[key] = info;
                material.TextureParams.Clear();
            }
            return resource;
        }
        public void ReleaseChunk()
        {
            foreach (var resource in resources) resource.Dispose();
            resources.Clear();
            Materials.Clear();
        }
    }

    public static void Prepare(string mapPath, string output, string collisionFingerprint, bool force)
    {
        var timer = Stopwatch.StartNew();
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            collisionFingerprint + File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderExport.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-prepare.mjs")))));
        var manifest = Path.Combine(output, "render.json");
        if (!force && File.Exists(manifest))
        {
            using var old = JsonDocument.Parse(File.ReadAllText(manifest));
            if (old.RootElement.GetProperty("fingerprint").GetString() == fingerprint &&
                old.RootElement.GetProperty("files").EnumerateArray().All(file =>
                    File.Exists(Path.Combine(output, file.GetProperty("path").GetString()!)) &&
                    new FileInfo(Path.Combine(output, file.GetProperty("path").GetString()!)).Length == file.GetProperty("bytes").GetInt64()))
            {
                Console.WriteLine($"Cached textured Inferno valid ({timer.Elapsed.TotalMilliseconds:F0} ms).");
                return;
            }
        }
        var folder = Path.Combine(output, "render");
        Directory.CreateDirectory(folder);
        // Invalidate before a new export; an interrupted export is never considered complete.
        if (File.Exists(manifest)) File.Delete(manifest);
        using var package = new Package(); package.Read(mapPath);
        using var loader = new RenderLoader(package, mapPath);
        using var rawLoader = new GameFileLoader(package, mapPath);
        using var map = rawLoader.LoadFileCompiled("maps/de_inferno.vmap")!;
        var extract = new MapExtract(map, rawLoader);
        using var worldResource = rawLoader.LoadFileCompiled($"{extract.LumpFolder}/world.vwrld")!;
        var world = (World)worldResource.DataBlock!;
        var nodes = world.GetWorldNodeNames().ToArray();
        var chunks = new List<string>();
        var textures = new Dictionary<string, TextureInfo>();
        var warnings = new HashSet<string>();
        var primitives = 0; var meshCount = 0; var triangleCount = 0L; var texturedTriangleCount = 0L; var materialCount = 0;
        for (var i = 0; i < nodes.Length; i++)
        {
            Console.WriteLine($"Render chunk {i + 1}/{nodes.Length}: {nodes[i]} ({timer.Elapsed.TotalSeconds:F1} s)");
            var relative = $"render/chunk-{i:D3}.gltf";
            var destination = Path.Combine(output, relative);
            var node = loader.LoadFileCompiled(nodes[i] + ".vwnod")!;
            var exporter = new GltfModelExporter(loader)
            {
                ProgressReporter = new Reporter(), ExportAnimations = false,
                ExportMaterials = true, AdaptTextures = true, SatelliteImages = true, ExportExtras = false,
            };
            exporter.Export(node, destination);
            var gltf = JsonNode.Parse(File.ReadAllText(destination))!.AsObject();
            CompactGeometry(gltf, folder, $"chunk-{i:D3}");
            var images = new JsonArray(); var gltfTextures = new JsonArray();
            if (gltf["materials"] is JsonArray materials)
            {
                materialCount += materials.Count;
                foreach (var materialNode in materials)
                {
                    var material = materialNode!.AsObject();
                    var name = material["name"]!.GetValue<string>();
                    if (!loader.Materials.TryGetValue(name, out var source)) continue;
                    material["extras"] = new JsonObject { ["sourceMaterial"] = source.Path };
                    if (source.Texture == null) continue;
                    var key = source.Texture + "|" + source.KeepAlpha;
                    if (!textures.TryGetValue(key, out var texture))
                    {
                        using var resource = rawLoader.LoadFileCompiled(source.Texture);
                        if (resource?.DataBlock is not Texture data)
                        {
                            warnings.Add("Missing base texture: " + source.Texture); continue;
                        }
                        var level = 0u;
                        while (level + 1 < data.NumMipLevels && Math.Max(data.Width >> (int)level, data.Height >> (int)level) > TextureSize) level++;
                        using var bitmap = data.GenerateBitmap(mipLevel: level);
                        // Color alpha often encodes reflectance rather than transparency.
                        // Keep it only when the material actually requests alpha blend/test.
                        if (!source.KeepAlpha)
                        {
                            var pixels = bitmap.Pixels;
                            for (var pixel = 0; pixel < pixels.Length; pixel++) pixels[pixel] = pixels[pixel].WithAlpha(255);
                            bitmap.Pixels = pixels;
                        }
                        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..20];
                        var file = "tex-" + hash + ".png";
                        using var encoded = bitmap.Encode(SKEncodedImageFormat.Png, 100);
                        using (var stream = File.Create(Path.Combine(folder, file))) encoded.SaveTo(stream);
                        texture = new TextureInfo(file, bitmap.Width, bitmap.Height, new FileInfo(Path.Combine(folder, file)).Length);
                        textures[key] = texture;
                        if (Math.Max(bitmap.Width, bitmap.Height) > TextureSize) warnings.Add("Texture lacks small mip: " + source.Texture);
                    }
                    var index = images.Count;
                    images.Add(new JsonObject { ["uri"] = texture.File });
                    gltfTextures.Add(new JsonObject { ["sampler"] = 0, ["source"] = index });
                    material["pbrMetallicRoughness"]!["baseColorTexture"] = new JsonObject { ["index"] = index };
                }
            }
            gltf["images"] = images; gltf["textures"] = gltfTextures;
            gltf["samplers"] = new JsonArray(new JsonObject { ["magFilter"] = 9729, ["minFilter"] = 9987, ["wrapS"] = 10497, ["wrapT"] = 10497 });
            if (gltf["meshes"] is JsonArray meshes)
            {
                meshCount += meshes.Count;
                foreach (var mesh in meshes)
                foreach (var primitive in mesh!["primitives"]!.AsArray())
                {
                    primitives++;
                    var accessor = primitive!["indices"]!.GetValue<int>();
                    var triangles = gltf["accessors"]![accessor]!["count"]!.GetValue<int>() / 3;
                    triangleCount += triangles;
                    if (primitive["material"] is JsonNode materialIndex &&
                        gltf["materials"]![materialIndex.GetValue<int>()]!["pbrMetallicRoughness"]?["baseColorTexture"] != null)
                        texturedTriangleCount += triangles;
                }
            }
            File.WriteAllText(destination, gltf.ToJsonString());
            chunks.Add(relative);
            loader.ReleaseChunk();
            Console.WriteLine($"  {textures.Count} unique base textures, {triangleCount:N0} render triangles so far; {timer.Elapsed.TotalSeconds:F1} s");
        }
        // VRF 20.1 bakes this conversion into geometry and conjugates prop placements with it.
        // Serialize its inverse in Three.js / glTF column-major order (Numerics uses row vectors).
        var conversion = Matrix4x4.CreateScale(0.0254f) * Matrix4x4.CreateFromQuaternion(
            Quaternion.CreateFromYawPitchRoll(0, -MathF.PI / 2, -MathF.PI / 2));
        Matrix4x4.Invert(conversion, out var inverse);
        float[] gltfToSource = [inverse.M11, inverse.M12, inverse.M13, inverse.M14, inverse.M21, inverse.M22, inverse.M23, inverse.M24,
            inverse.M31, inverse.M32, inverse.M33, inverse.M34, inverse.M41, inverse.M42, inverse.M43, inverse.M44];
        var usedFiles = new HashSet<string>(chunks);
        foreach (var chunk in chunks)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(output, chunk)));
            foreach (var buffer in document.RootElement.GetProperty("buffers").EnumerateArray())
                usedFiles.Add("render/" + buffer.GetProperty("uri").GetString()!);
        }
        foreach (var texture in textures.Values) usedFiles.Add("render/" + texture.File);
        var files = usedFiles.Order().Select(path => new { path, bytes = new FileInfo(Path.Combine(output, path)).Length }).ToArray();
        var metadata = new
        {
            schema = 1, map = "de_inferno", fingerprint, collisionFingerprint, preparedAt = DateTime.UtcNow,
            prepareMs = timer.Elapsed.TotalMilliseconds, chunks, gltfToSource, textureMaxSize = TextureSize,
            meshCount, primitives, triangleCount, texturedTriangleCount, materialCount, textureCount = textures.Count,
            textureBytes = textures.Values.Sum(t => t.Bytes),
            estimatedTextureGpuBytes = textures.Values.Sum(t => (long)t.Width * t.Height * 4 * 4 / 3),
            totalBytes = files.Sum(f => f.bytes), files,
            warnings = warnings.Concat(new[] {
                "Render geometry is for display only; separate vphys data drives shots and walking.",
                "Base-color texture first layer only; no Source 2 layered blending, normal/roughness maps, baked lighting or shader parity.",
                "Static world-node models only; entity-driven doors, breakables, movable props, skybox and live state omitted."
            }),
        };
        File.WriteAllText(manifest + ".tmp", JsonSerializer.Serialize(metadata)); File.Move(manifest + ".tmp", manifest, true);
        Console.WriteLine($"Textured Inferno: {triangleCount:N0} triangles, {primitives:N0} primitives, {textures.Count} base textures; {files.Sum(f => f.bytes) / 1048576.0:F1} MiB disk, {metadata.estimatedTextureGpuBytes / 1048576.0:F1} MiB estimated texture GPU; {timer.Elapsed.TotalSeconds:F2} s.");
    }

    private static void CompactGeometry(JsonObject gltf, string folder, string name)
    {
        var oldAccessors = gltf["accessors"]!.AsArray();
        var oldViews = gltf["bufferViews"]!.AsArray();
        var oldBuffers = gltf["buffers"]!.AsArray();
        var accessors = new JsonArray(); var views = new JsonArray();
        var accessorMap = new Dictionary<int, int>(); var viewMap = new Dictionary<int, int>();
        var compactFile = name + "-compact.bin";
        using (var stream = File.Create(Path.Combine(folder, compactFile)))
        {
            int CopyAccessor(int oldIndex)
            {
                if (accessorMap.TryGetValue(oldIndex, out var existing)) return existing;
                var accessor = oldAccessors[oldIndex]!.DeepClone().AsObject();
                var oldViewIndex = accessor["bufferView"]!.GetValue<int>();
                if (!viewMap.TryGetValue(oldViewIndex, out var newViewIndex))
                {
                    var view = oldViews[oldViewIndex]!.DeepClone().AsObject();
                    var buffer = view["buffer"]!.GetValue<int>();
                    var file = oldBuffers[buffer]!["uri"]!.GetValue<string>();
                    var sourcePath = Path.GetFullPath(Path.Combine(folder, file));
                    if (!sourcePath.StartsWith(Path.GetFullPath(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Render buffer escaped output folder");
                    using var source = File.OpenRead(sourcePath);
                    source.Position = view["byteOffset"]?.GetValue<long>() ?? 0;
                    while (stream.Position % 4 != 0) stream.WriteByte(0);
                    view["buffer"] = 0; view["byteOffset"] = stream.Position;
                    var remaining = view["byteLength"]!.GetValue<long>();
                    var bytes = new byte[65536];
                    while (remaining > 0)
                    {
                        var read = source.Read(bytes, 0, (int)Math.Min(bytes.Length, remaining));
                        if (read == 0) throw new EndOfStreamException("Truncated render buffer");
                        stream.Write(bytes, 0, read); remaining -= read;
                    }
                    newViewIndex = views.Count; views.Add(view); viewMap[oldViewIndex] = newViewIndex;
                }
                accessor["bufferView"] = newViewIndex;
                var index = accessors.Count; accessors.Add(accessor); accessorMap[oldIndex] = index;
                return index;
            }
            foreach (var mesh in gltf["meshes"]!.AsArray())
            foreach (var primitive in mesh!["primitives"]!.AsArray())
            {
                var attributes = primitive!["attributes"]!.AsObject();
                foreach (var key in attributes.Select(pair => pair.Key).ToArray())
                {
                    // COLOR_0 stores Source shader blend weights as well as color; first-layer
                    // rendering must not multiply its RGB by these weights. Other UVs/tangents
                    // are unused because this POC intentionally exports only base color.
                    if (key is not ("POSITION" or "NORMAL" or "TEXCOORD_0")) attributes.Remove(key);
                    else attributes[key] = CopyAccessor(attributes[key]!.GetValue<int>());
                }
                primitive["indices"] = CopyAccessor(primitive["indices"]!.GetValue<int>());
            }
            gltf["buffers"] = new JsonArray(new JsonObject { ["uri"] = compactFile, ["byteLength"] = stream.Length });
        }
        gltf["accessors"] = accessors; gltf["bufferViews"] = views;
        // Delete only the exact exporter-generated originals inside this private render folder.
        foreach (var buffer in oldBuffers)
        {
            var file = buffer!["uri"]!.GetValue<string>();
            var path = Path.GetFullPath(Path.Combine(folder, file));
            if (!path.StartsWith(Path.GetFullPath(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Render buffer escaped output folder");
            File.Delete(path);
        }
    }
}
