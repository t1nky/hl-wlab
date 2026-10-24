using System.Diagnostics;
using System.IO.Compression;
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
using ValveResourceFormat.Serialization.KeyValues;
using VMaterial = ValveResourceFormat.ResourceTypes.Material;

// Render data never supplies bullet or player collision. All derived content stays in .local.
internal static class RenderExport
{
    private const int TextureSize = 512;
    private sealed record TextureInfo(string File, int Width, int Height, long Bytes, Vector3 Average, JsonObject? Native = null);
    private sealed record MaskInfo(string File, int Width, int Height, long Bytes) { public int GpuBytes => Width * Height; }
    private sealed record MaterialInfo(string Path, string? Texture, bool KeepAlpha, string Shader,
        int BlendMode, float AlphaCutoff, float Opacity, Dictionary<string, Vector4> Vectors,
        Dictionary<string, float> Floats, Dictionary<string, long> Integers, Dictionary<string, string> Textures, string[] Layers, bool Tools);
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
                var blend = material.ShaderName.EndsWith("static_overlay.vfx")
                    ? (int)material.IntParams.GetValueOrDefault("F_BLEND_MODE") : 0;
                if (blend == 0 && material.IntParams.GetValueOrDefault("F_ALPHA_TEST") > 0) blend = 2;
                if (blend == 0 && (material.IntParams.GetValueOrDefault("F_TRANSLUCENT") > 0 || material.ShaderName.Contains("glass"))) blend = 1;
                var alpha = blend != 0;
                var key = (file.EndsWith("_c") ? file[..^2] : file).Replace('\\', '/');
                var layers = new List<string>();
                if (material.ShaderName == "csgo_environment_blend.vfx") {
                    if (material.TextureParams.TryGetValue("g_tColor2", out var second)) layers.Add(second);
                    if (material.IntParams.GetValueOrDefault("F_ENABLE_LAYER_3") > 0 && material.TextureParams.TryGetValue("g_tColor3", out var third)) layers.Add(third);
                }
                if (material.ShaderName == "csgo_lightmappedgeneric.vfx" && material.IntParams.GetValueOrDefault("F_LAYERS") > 0) {
                    if (!material.TextureParams.TryGetValue("g_tLayer2Color", out var second))
                        throw new InvalidDataException("Missing generic blend layer: " + file);
                    layers.Add(second);
                }
                var info = new MaterialInfo(file, color, alpha, material.ShaderName, blend,
                    material.FloatParams.GetValueOrDefault("g_flAlphaTestReference", 0.5f),
                    material.FloatParams.GetValueOrDefault("g_flOpacityScale", 1f),
                    new(material.VectorParams), new(material.FloatParams),
                    material.IntParams.ToDictionary(p => p.Key, p => (long)p.Value), new(material.TextureParams), layers.ToArray(), material.IntAttributes.ContainsKey("tools.toolsmaterial"));
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

    public static void Prepare(string mapPath, string gameInfoPath, string resourcePath, string mapName, string output, string collisionFingerprint, bool force)
    {
        var timer = Stopwatch.StartNew();
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            collisionFingerprint + File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderExport.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderSunShadows.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderSunBlocks.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderTint.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderVisibility.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderIrradiance.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderTextureBlocks.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/RenderSky.cs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-prepare.mjs")) +
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-render-pack.mjs")))));
        var manifest = Path.Combine(output, "render.json");
        if (!force && File.Exists(manifest))
        {
            using var old = JsonDocument.Parse(File.ReadAllText(manifest));
            if (old.RootElement.GetProperty("fingerprint").GetString() == fingerprint &&
                old.RootElement.GetProperty("files").EnumerateArray().All(file =>
                    File.Exists(Path.Combine(output, file.GetProperty("path").GetString()!)) &&
                    new FileInfo(Path.Combine(output, file.GetProperty("path").GetString()!)).Length == file.GetProperty("bytes").GetInt64()))
            {
                Console.WriteLine($"Cached textured {mapName} valid ({timer.Elapsed.TotalMilliseconds:F0} ms).");
                return;
            }
        }
        var folder = Path.Combine(output, "render");
        Directory.CreateDirectory(folder);
        // Invalidate before a new export; an interrupted export is never considered complete.
        if (File.Exists(manifest)) File.Delete(manifest);
        using var package = new Package(); package.Read(mapPath);
        using var loader = new RenderLoader(package, gameInfoPath);
        using var rawLoader = new GameFileLoader(package, gameInfoPath);
        using var map = rawLoader.LoadFileCompiled(resourcePath)!;
        var extract = new MapExtract(map, rawLoader);
        using var worldResource = rawLoader.LoadFileCompiled($"{extract.LumpFolder}/world.vwrld")!;
        var world = (World)worldResource.DataBlock!;
        var warnings = new HashSet<string>();
        JsonObject? sunShadows = null, irradiance = null, sky = null;
        // Some maps are indoors, unlit, or use another bake format. Geometry/collision
        // remain useful with fallback lighting; never apply an incompatible atlas.
        try { sunShadows = RenderSunShadows.Export(world, rawLoader, folder); }
        catch (Exception e) when (e is InvalidDataException or InvalidOperationException or FileNotFoundException) { warnings.Add("Baked sunlight unavailable: " + e.Message); }
        // Indirect lighting is independent of the direct shadow atlas format.
        try { irradiance = RenderIrradiance.Export(world, rawLoader, folder); }
        catch (Exception e) when (e is InvalidDataException or InvalidOperationException or FileNotFoundException) { warnings.Add("Baked irradiance unavailable: " + e.Message); }
        try { sky = RenderSky.Export(world, rawLoader, folder); }
        catch (Exception e) when (e is InvalidDataException or InvalidOperationException or FileNotFoundException) { warnings.Add("HDR sky unavailable: " + e.Message); }
        var nodes = world.GetWorldNodeNames().ToArray();
        var chunks = new List<string>();
        var textures = new Dictionary<string, TextureInfo>();
        var imageContents = new Dictionary<string, TextureInfo>();
        var masks = new Dictionary<string, MaskInfo>();
        var maskContents = new Dictionary<string, MaskInfo>();
        var primitives = 0; var meshCount = 0; var triangleCount = 0L; var texturedTriangleCount = 0L; var materialCount = 0; var excludedLods = 0; var maskedTintMaterials = 0;
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
            // Bind full source paths before dropping LoDs: their now-unused materials
            // may share a basename with a surviving material from another directory.
            RenderSunShadows.Bind((WorldNode)node.DataBlock!, gltf, rawLoader);
            excludedLods += FilterAggregateLods((WorldNode)node.DataBlock!, gltf);
            CompactGeometry(gltf, folder, $"chunk-{i:D3}");
            var images = new JsonArray(); var gltfTextures = new JsonArray(); var imageInfos = new List<TextureInfo>();
            if (gltf["materials"] is JsonArray materials)
            {
                materialCount += materials.Count;
                foreach (var materialNode in materials)
                {
                    var material = materialNode!.AsObject();
                    var name = material["extras"]?["sourceMaterial"]?.GetValue<string>();
                    if (name == null || !loader.Materials.TryGetValue(name, out var source))
                        throw new InvalidDataException("Missing full-path render material binding: " + material["name"]);
                    material["alphaMode"] = source.BlendMode == 2 ? "MASK" : source.BlendMode != 0 ? "BLEND" : "OPAQUE";
                    if (source.BlendMode == 2) material["alphaCutoff"] = source.AlphaCutoff;
                    material["extras"] = new JsonObject { ["sourceMaterial"] = source.Path, ["tools"] = source.Tools,
                        ["staticSurface"] = RenderVisibility.IsStaticSurface(source.Shader, source.Tools),
                        ["cs2"] = new JsonObject { ["shader"] = source.Shader, ["blendMode"] = source.BlendMode,
                            // VRF 20.1 adds this displacement after converting vertices to metres.
                            // Restore original positions during packing; browser depth bias handles z-fighting.
                            ["vrfOverlayOffsetMetres"] = HasVrfOverlayOffset(source) ? 0.01f / 0.0254f : 0f,
                            ["depthBias"] = HasVrfOverlayOffset(source),
                            ["vertexPaint"] = source.Shader.Contains("foliage") ? "none" : source.Shader.Contains("environment") ? "environment" :
                                source.Integers.GetValueOrDefault("F_PAINT_VERTEX_COLORS") > 0 || source.Integers.GetValueOrDefault("F_VERTEX_COLOR") > 0 ?
                                source.Shader.Contains("static_overlay") ? "overlay" : "srgb" : "none",
                            ["opacity"] = source.Opacity, ["uv"] = UvSettings(source, source.Shader.Contains("environment") ? "1" : ""),
                            ["layers"] = new JsonArray() } };
                    if (source.Texture == null) continue;
                    var pbr = material["pbrMetallicRoughness"]!.AsObject();
                    var factor = pbr["baseColorFactor"]?.AsArray();
                    var exportedTint = factor == null ? Vector3.One : new Vector3(factor[0]!.GetValue<float>(), factor[1]!.GetValue<float>(), factor[2]!.GetValue<float>());
                    var tint4 = source.Vectors.GetValueOrDefault("g_vColorTint", Vector4.One);
                    var materialSrgb = new Vector3(tint4.X, tint4.Y, tint4.Z);
                    var materialLinear = RenderTint.Linear(materialSrgb);
                    var amount = source.Floats.GetValueOrDefault("g_flModelTintAmount", 1f);
                    var modelTint = RenderTint.RecoverModelTint(exportedTint, materialSrgb, amount);
                    // Preserve original RGBA for affine material correction in the browser.
                    // The independent green mask is a shared R8 texture, never a color variant.
                    var maskedTint = source.Shader is "csgo_environment.vfx" or "csgo_environment_blend.vfx" && !source.KeepAlpha;
                    if (maskedTint && Enumerable.Range(1, source.Layers.Length + 1).Any(layer => !source.Textures.ContainsKey($"g_tHeight{layer}"))) {
                        warnings.Add("Masked model tint lacks a layer height texture: " + source.Path); maskedTint = false;
                    }
                    JsonObject TintSettings(int layer, int textureIndex) {
                        var csb = new Vector3(source.Floats.GetValueOrDefault($"g_fTextureColorContrast{layer}", 1f),
                            source.Floats.GetValueOrDefault($"g_fTextureColorSaturation{layer}", 1f), source.Floats.GetValueOrDefault($"g_fTextureColorBrightness{layer}", 1f));
                        var t = source.Vectors.GetValueOrDefault($"g_vTextureColorTint{layer}", Vector4.One);
                        var correction = RenderTint.ColorCorrection(csb, imageInfos[textureIndex].Average);
                        var tinted = correction * RenderTint.ColorTint(new Vector3(t.X, t.Y, t.Z));
                        return new JsonObject {
                            ["enabled"] = source.Integers.GetValueOrDefault($"g_bModelTint{layer}", 1) != 0,
                            ["contrast"] = source.Floats.GetValueOrDefault($"g_fTintMaskContrast{layer}", 1f),
                            ["brightness"] = source.Floats.GetValueOrDefault($"g_fTintMaskBrightness{layer}", 1f),
                            ["vertexColorMode"] = source.Shader == "csgo_environment.vfx" ? 1 : source.Integers.GetValueOrDefault($"g_nVertexColorMode{layer}", 0),
                            ["correction"] = MatrixJson(correction), ["tintedCorrection"] = MatrixJson(tinted),
                            ["unmaskedCorrection"] = source.Integers.GetValueOrDefault($"g_nColorCorrectionMode{layer}", 0) == 1,
                            ["mask"] = AddMask(source.Textures[$"g_tHeight{layer}"]),
                        };
                    }
                    JsonObject AddMask(string maskPath, int channel = 1) {
                        var maskKey = maskPath + "|" + channel;
                        if (!masks.TryGetValue(maskKey, out var mask)) {
                            using var resource = rawLoader.LoadFileCompiled(maskPath);
                            if (resource?.DataBlock is not Texture data) throw new InvalidDataException("Missing tint mask: " + maskPath);
                            var level = 0u;
                            while (level + 1 < data.NumMipLevels && Math.Max(data.Width >> (int)level, data.Height >> (int)level) > TextureSize) level++;
                            using var bitmap = data.GenerateBitmap(mipLevel: level);
                            var bytes = bitmap.Pixels.Select(pixel => channel switch { 0 => pixel.Red, 1 => pixel.Green, 3 => pixel.Alpha, _ => throw new InvalidDataException("Unsupported material mask channel") }).ToArray();
                            var hash = PixelHash(bitmap.Width, bitmap.Height, bytes);
                            if (!maskContents.TryGetValue(hash, out mask)) {
                                var file = "mask-" + hash[..20] + ".r8.gz";
                                using (var stream = File.Create(Path.Combine(folder, file)))
                                using (var gzip = new GZipStream(stream, CompressionLevel.SmallestSize)) gzip.Write(bytes);
                                mask = new MaskInfo(file, bitmap.Width, bitmap.Height, new FileInfo(Path.Combine(folder, file)).Length);
                                maskContents[hash] = mask;
                            }
                            masks[maskKey] = mask;
                        }
                        return new JsonObject { ["file"] = "render/" + mask.File, ["width"] = mask.Width, ["height"] = mask.Height,
                            ["format"] = "R8_UNORM", ["gpuBytes"] = mask.GpuBytes, ["bytes"] = mask.Bytes };
                    }
                    int AddTexture(string texturePath, bool keepAlpha, int layer = 1) {
                        var preserveAlpha = keepAlpha || maskedTint;
                        var key = texturePath + "|" + preserveAlpha + "|" + keepAlpha;
                        if (!textures.TryGetValue(key, out var texture)) {
                            using var resource = rawLoader.LoadFileCompiled(texturePath);
                            if (resource?.DataBlock is not Texture data) throw new InvalidDataException("Missing base texture: " + texturePath);
                            var level = 0u;
                            while (level + 1 < data.NumMipLevels && Math.Max(data.Width >> (int)level, data.Height >> (int)level) > TextureSize) level++;
                            using var bitmap = data.GenerateBitmap(mipLevel: level);
                            if (!preserveAlpha) {
                                var pixels = bitmap.Pixels;
                                for (var pixel = 0; pixel < pixels.Length; pixel++) pixels[pixel] = pixels[pixel].WithAlpha(255);
                                bitmap.Pixels = pixels;
                            }
                            var average = new Vector3(data.Reflectivity.X, data.Reflectivity.Y, data.Reflectivity.Z);
                            var hash = PixelHash(bitmap.Width, bitmap.Height, bitmap.GetPixelSpan());
                            // Opacity images retain PNG even if an identical opaque image uses WebP.
                            var contentKey = hash + "|" + keepAlpha;
                            if (!imageContents.TryGetValue(contentKey, out var content)) {
                                using var png = bitmap.Encode(SKEncodedImageFormat.Png, 100);
                                using var pixmap = bitmap.PeekPixels();
                                using var webp = !keepAlpha ? pixmap.Encode(new SKWebpEncoderOptions(SKWebpEncoderCompression.Lossless, 75)) : null;
                                var useWebp = false;
                                if (webp != null && webp.Size < png.Size) {
                                    // Decode as unpremultiplied RGBA: compare hidden RGB at alpha zero,
                                    // not a premultiplied view that can silently erase source colors.
                                    using var codec = SKCodec.Create(webp);
                                    using var restored = new SKBitmap(codec.Info.WithAlphaType(SKAlphaType.Unpremul));
                                    var decoded = codec.GetPixels(restored.Info, restored.GetPixels());
                                    useWebp = decoded == SKCodecResult.Success && restored.Width == bitmap.Width && restored.Height == bitmap.Height &&
                                        restored.Pixels.AsSpan().SequenceEqual(bitmap.Pixels);
                                }
                                var file = "tex-" + hash[..20] + (useWebp ? ".webp" : ".png");
                                using (var stream = File.Create(Path.Combine(folder, file))) (useWebp ? webp! : png).SaveTo(stream);
                                content = new TextureInfo(file, bitmap.Width, bitmap.Height, new FileInfo(Path.Combine(folder, file)).Length, average);
                                imageContents[contentKey] = content;
                            }
                            texture = content with { Average = average, Native = RenderTextureBlocks.Export(data, level, folder) };
                            if (texture.Native != null) { texture.Native["source"] = texturePath; texture.Native["sourceMip"] = level; }
                            textures[key] = texture;
                            if (Math.Max(bitmap.Width, bitmap.Height) > TextureSize) warnings.Add("Texture lacks small mip: " + texturePath);
                        }
                        var index = images.Count;
                        images.Add(new JsonObject { ["uri"] = texture.File });
                        gltfTextures.Add(new JsonObject { ["sampler"] = 0, ["source"] = index,
                            ["extras"] = new JsonObject { ["cs2Native"] = texture.Native?.DeepClone() } });
                        imageInfos.Add(texture);
                        return index;
                    }
                    var index = AddTexture(source.Texture, source.KeepAlpha);
                    pbr["baseColorTexture"] = new JsonObject { ["index"] = index };
                    foreach (var (layer, layerIndex) in source.Layers.Select((path, index) => (path, index))) {
                        var settings = new JsonObject { ["texture"] = AddTexture(layer, false, layerIndex + 2), ["uv"] = UvSettings(source, (layerIndex + 2).ToString()) };
                        if (maskedTint) settings["tint"] = TintSettings(layerIndex + 2, settings["texture"]!.GetValue<int>());
                        material["extras"]!["cs2"]!["layers"]!.AsArray().Add(settings);
                    }
                    if (source.Shader == "csgo_lightmappedgeneric.vfx" && source.Layers.Length > 0) {
                        var mode = (int)source.Integers.GetValueOrDefault("F_FANCY_BLENDING");
                        if (mode is < 0 or > 3) throw new InvalidDataException("Unsupported generic blend mode: " + mode);
                        var blend = new JsonObject { ["mode"] = mode, ["softness"] = source.Floats.GetValueOrDefault("g_flBlendSoftness", 0.5f) };
                        if (mode > 0) {
                            if (!source.Textures.TryGetValue("g_tBlendModulation", out var modulation))
                                throw new InvalidDataException("Missing generic blend modulation: " + source.Path);
                            blend["mask"] = AddMask(modulation, mode == 3 ? 3 : 1);
                            if (mode == 1) blend["softnessMask"] = AddMask(modulation, 0);
                        }
                        material["extras"]!["cs2"]!["genericBlend"] = blend;
                    }
                    if (maskedTint) {
                        // Retain instance color for BatchedMesh's existing per-instance color stream.
                        pbr["baseColorFactor"] = new JsonArray(modelTint.X, modelTint.Y, modelTint.Z, factor?[3]?.GetValue<float>() ?? 1f);
                        material["extras"]!["cs2"]!["tint"] = new JsonObject { ["amount"] = amount,
                            ["material"] = new JsonArray(materialLinear.X, materialLinear.Y, materialLinear.Z), ["base"] = TintSettings(1, index) };
                        maskedTintMaterials++;
                    }
                }
            }
            gltf["images"] = images; gltf["textures"] = gltfTextures;
            gltf["samplers"] = new JsonArray(new JsonObject { ["magFilter"] = 9729, ["minFilter"] = 9987, ["wrapS"] = 10497, ["wrapT"] = 10497 });
            PruneMeshes(gltf, mesh => {
                var items = mesh["primitives"]!.AsArray();
                foreach (var item in items.ToArray()) {
                    var index = item!["material"]?.GetValue<int>();
                    if (index.HasValue && gltf["materials"]![index.Value]!["extras"]?["staticSurface"]?.GetValue<bool>() == false) items.Remove(item);
                }
                return items.Count == 0;
            });
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
        foreach (var texture in imageContents.Values) usedFiles.Add("render/" + texture.File);
        foreach (var texture in textures.Values) if (texture.Native != null) usedFiles.Add(texture.Native["file"]!.GetValue<string>());
        foreach (var mask in maskContents.Values) usedFiles.Add("render/" + mask.File);
        if (sunShadows != null) usedFiles.Add(sunShadows["file"]!.GetValue<string>());
        if (irradiance != null) usedFiles.Add(irradiance["file"]!.GetValue<string>());
        if (sky != null) usedFiles.Add(sky["file"]!.GetValue<string>());
        var nativeTextures = textures.Values.Where(t => t.Native != null).Select(t => t.Native!).DistinctBy(n => n["file"]!.GetValue<string>()).ToArray();
        var files = usedFiles.Order().Select(path => new { path, bytes = new FileInfo(Path.Combine(output, path)).Length }).ToArray();
        var metadata = new
        {
            schema = 1, map = mapName, fingerprint, collisionFingerprint, preparedAt = DateTime.UtcNow,
            prepareMs = timer.Elapsed.TotalMilliseconds, chunks, gltfToSource, textureMaxSize = TextureSize,
            meshCount, primitives, triangleCount, texturedTriangleCount, materialCount, excludedLods, textureCount = imageContents.Count,
            maskedTintMaterials, textureBytes = imageContents.Values.Sum(t => t.Bytes),
            maskTextureCount = maskContents.Count, maskTextureBytes = maskContents.Values.Sum(t => t.Bytes), maskTextureGpuBytes = maskContents.Values.Sum(t => (long)t.GpuBytes),
            sunShadows, irradiance, sky, environment = RenderSky.Environment(world, rawLoader),
            textureEncoding = new { opaque = "smallest of PNG / verified lossless WebP", alpha = "PNG", pixelRoundTripVerified = true,
                webpCount = imageContents.Values.Count(t => t.File.EndsWith(".webp")),
                native = "Authored BC1/BC7 blocks and mips, no recompression; portable images retained for fallback",
                nativeCount = nativeTextures.Length, nativeGpuBytes = nativeTextures.Sum(n => n["gpuBytes"]!.GetValue<int>()) },
            estimatedTextureGpuBytes = imageContents.Values.Sum(t => (long)t.Width * t.Height * 4 * 4 / 3) + maskContents.Values.Sum(t => (long)t.GpuBytes) + (sunShadows?["gpuBytes"]?.GetValue<int>() ?? 0) + (irradiance?["gpuBytes"]?.GetValue<int>() ?? 0),
            totalBytes = files.Sum(f => f.bytes), files,
            warnings = warnings.Concat(new[] {
                "Render geometry is for display only; separate vphys data drives shots and walking.",
                "Generic terrain layers use TEXCOORD4 weights and original blend modulation channels. Environment height blending, normal/roughness, directional irradiance and full Source shader parity omitted. Baked lighting uses native BC4/BC7 sun visibility and bounded BC6H irradiance.",
                "Opaque environment original RGBA and lossless shared R8 height-green masks drive runtime affine color correction, model tint and vertex paint. Shared overlays and other shader families remain approximations.",
                "Static world-node surfaces and optional authored HDR sky cube only; atmospheric-effect proxies, entity-driven doors, breakables, movable props, 3D sky scene, particle ropes and live state omitted."
            }),
        };
        File.WriteAllText(manifest + ".tmp", JsonSerializer.Serialize(metadata)); File.Move(manifest + ".tmp", manifest, true);
        Console.WriteLine($"Textured {mapName}: {triangleCount:N0} triangles, {primitives:N0} primitives, {textures.Count} base textures; {files.Sum(f => f.bytes) / 1048576.0:F1} MiB disk, {metadata.estimatedTextureGpuBytes / 1048576.0:F1} MiB estimated texture GPU; {timer.Elapsed.TotalSeconds:F2} s.");
    }

    private static JsonArray MatrixJson(Matrix4x4 m) => new(m.M11, m.M12, m.M13, m.M14, m.M21, m.M22, m.M23, m.M24,
        m.M31, m.M32, m.M33, m.M34, m.M41, m.M42, m.M43, m.M44);

    private static string PixelHash(int width, int height, ReadOnlySpan<byte> bytes) {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(BitConverter.GetBytes(width)); hash.AppendData(BitConverter.GetBytes(height)); hash.AppendData(bytes);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    private static bool HasVrfOverlayOffset(MaterialInfo material) =>
        material.Integers.GetValueOrDefault("F_OVERLAY") == 1 ||
        material.Integers.GetValueOrDefault("F_DEPTHBIAS") == 1 ||
        material.Integers.GetValueOrDefault("F_DEPTH_BIAS") == 1 ||
        material.Shader.EndsWith("static_overlay.vfx", StringComparison.Ordinal) ||
        material.Shader == "citadel_overlay.vfx";

    // VRF's glTF exporter currently emits all aggregate LoDs; its renderer selects only
    // the lowest present mask bit. Filter after export, so skipped fragments still consume
    // their original transform entries and cannot shift later instance placements.
    private static int FilterAggregateLods(WorldNode node, JsonObject gltf)
    {
        var excluded = new HashSet<string>();
        foreach (var aggregate in node.AggregateSceneObjects) {
            var model = aggregate.GetStringProperty("m_renderableModel");
            if (model == null) continue;
            var name = Path.GetFileNameWithoutExtension(model);
            var fragments = aggregate.GetArray("m_aggregateMeshes");
            uint combined = 0;
            foreach (var fragment in fragments) combined |= fragment.GetUInt32Property("m_nLODGroupMask");
            var lowestBit = combined & (~combined + 1);
            for (var i = 0; i < fragments.Count; i++) {
                var mask = fragments[i].GetUInt32Property("m_nLODGroupMask");
                if (mask != 0 && (mask & lowestBit) == 0) excluded.Add($"{name}_fragment{i + 1}");
            }
        }
        return PruneMeshes(gltf, mesh => excluded.Contains(mesh["name"]!.GetValue<string>()));
    }

    private static int PruneMeshes(JsonObject gltf, Func<JsonObject, bool> remove)
    {
        var meshes = gltf["meshes"]!.AsArray();
        var map = new Dictionary<int, int>();
        var kept = new JsonArray();
        for (var i = 0; i < meshes.Count; i++) if (!remove(meshes[i]!.AsObject())) {
            map[i] = kept.Count; kept.Add(meshes[i]!.DeepClone());
        }
        foreach (var item in gltf["nodes"]!.AsArray()) {
            if (item!["mesh"] is not JsonNode old) continue;
            if (map.TryGetValue(old.GetValue<int>(), out var next)) item["mesh"] = next;
            else item.AsObject().Remove("mesh");
        }
        var removed = meshes.Count - kept.Count;
        gltf["meshes"] = kept;
        return removed;
    }

    private static JsonObject UvSettings(MaterialInfo material, string suffix)
    {
        var scale = material.Vectors.GetValueOrDefault("g_vTexCoordScale" + suffix, Vector4.One);
        var offset = material.Vectors.GetValueOrDefault("g_vTexCoordOffset" + suffix);
        var center = material.Vectors.GetValueOrDefault("g_vTexCoordCenter" + suffix, new Vector4(0.5f));
        return new JsonObject { ["scale"] = new JsonArray(scale.X, scale.Y), ["offset"] = new JsonArray(offset.X, offset.Y),
            ["center"] = new JsonArray(center.X, center.Y), ["rotation"] = material.Floats.GetValueOrDefault("g_flTexCoordRotation" + suffix),
            ["channel"] = material.Integers.GetValueOrDefault("g_nUVSet" + suffix, 1) == 2 ? 1 : 0 };
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
                var lightUv = primitive["extras"]?["cs2Lighting"]?["attribute"]?.GetValue<string>();
                foreach (var key in attributes.Select(pair => pair.Key).ToArray())
                {
                    // COLOR_0 is vertex paint; TEXCOORD4 carries environment layer weights.
                    if (key != lightUv && key is not ("POSITION" or "NORMAL" or "TEXCOORD_0" or "TEXCOORD_1" or "COLOR_0" or "_TEXCOORD_4")) attributes.Remove(key);
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
