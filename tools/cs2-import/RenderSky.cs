using System.IO.Compression;
using System.Numerics;
using System.Text.Json.Nodes;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;

// A source-authored HDR cubemap. No bitmap expansion or CPU tone mapping.
internal static class RenderSky
{
    public static JsonObject? Environment(World world, GameFileLoader loader)
    {
        JsonObject? result = null; var visited = new HashSet<string>();
        void Visit(string name) {
            if (!visited.Add(name)) return;
            using var resource = loader.LoadFileCompiled(name); var lump = (EntityLump)resource!.DataBlock!;
            foreach (var e in lump.GetEntities()) if (e.GetStringProperty("classname") == "light_environment" && result == null) {
                var angles = e.GetVector3Property("angles"); var color = e.GetColor32Property("color");
                result = new JsonObject { ["angles"] = new JsonArray(angles.X, angles.Y, angles.Z),
                    ["color"] = new JsonArray(color.X, color.Y, color.Z), ["brightness"] = e.GetFloatProperty("brightness", 1f),
                    ["brightnessScale"] = e.GetFloatProperty("brightnessscale", 1f) };
            }
            foreach (var child in lump.GetChildEntityNames()) Visit(child);
        }
        foreach (var name in world.GetEntityLumpNames()) Visit(name);
        return result;
    }
    public static JsonObject? Export(World world, GameFileLoader loader, string folder)
    {
        EntityLump.Entity? selected = null; var seen = new HashSet<string>();
        void Visit(string name) {
            if (!seen.Add(name)) return;
            using var resource = loader.LoadFileCompiled(name); var lump = (EntityLump)resource!.DataBlock!;
            foreach (var e in lump.GetEntities()) if (e.GetStringProperty("classname") == "env_sky" &&
                e.GetIntegerProperty("startdisabled") == 0 && selected == null) selected = e;
            foreach (var child in lump.GetChildEntityNames()) Visit(child);
        }
        foreach (var name in world.GetEntityLumpNames()) Visit(name);
        var path = selected?.GetStringProperty("skyname");
        if (path == null) return null;
        using var materialResource = loader.LoadFileCompiled(path);
        var material = (Material)materialResource!.DataBlock!;
        if (!material.TextureParams.TryGetValue("g_tSkyTexture", out var texturePath)) return null;
        using var textureResource = loader.LoadFileCompiled(texturePath);
        var texture = (Texture)textureResource!.DataBlock!;
        if (texture.Format.ToString() != "BC6H" || !texture.Flags.ToString().Contains("CUBE") ||
            texture.Width != texture.Height || texture.Width > 2048) return null;
        // ReadTextureMipLevel orders +X,-X,+Y,-Y,+Z,-Z, with six faces per mip.
        // Keep one authored mip: a sky is sampled at infinity, without minification.
        var bytes = new byte[texture.CalculateBufferSizeForMipLevel(0)];
        if (bytes.Length != texture.Width * texture.Height * 6) throw new InvalidDataException("Invalid HDR sky cube size");
        texture.ReadTextureMipLevel(bytes, 0);
        const string file = "sky.bc6h.gz";
        using (var stream = File.Create(Path.Combine(folder, file)))
        using (var gzip = new GZipStream(stream, CompressionLevel.SmallestSize)) gzip.Write(bytes);
        var tint = selected!.GetColor32Property("tint_color");
        var scale = selected.GetFloatProperty("brightnessscale", 1f);
        tint *= scale * MathF.Pow(2, material.FloatParams.GetValueOrDefault("g_flBrightnessExposureBias") + material.FloatParams.GetValueOrDefault("g_flRenderOnlyExposureBias"));
        var angles = selected.GetVector3Property("angles");
        return new JsonObject { ["schema"] = 1, ["file"] = "render/" + file, ["format"] = "BC6H_UFLOAT_CUBE",
            ["size"] = texture.Width, ["gpuBytes"] = bytes.Length, ["source"] = texturePath, ["tint"] = new JsonArray(tint.X, tint.Y, tint.Z),
            ["angles"] = new JsonArray(angles.X, angles.Y, angles.Z), ["bytes"] = new FileInfo(Path.Combine(folder, file)).Length };
    }
}
