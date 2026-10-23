using System.IO.Compression;
using System.Text.Json.Nodes;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;

// The authored lower mip preserves normalized lightmap coordinates and BC6H HDR.
// Never decode this atlas into a large CPU bitmap or route it through albedo conversion.
internal static class RenderIrradiance
{
    public static JsonObject Export(World world, GameFileLoader loader, string folder)
    {
        var info = world.GetWorldLightingInfo();
        if (info.GetInt32Property("m_nLightmapVersionNumber") != 8 ||
            info.GetInt32Property("m_nLightmapGameVersionNumber") != 2 ||
            !info.GetBooleanProperty("m_bHasLightmaps") || info.GetBooleanProperty("m_bSHLightmaps"))
            throw new InvalidDataException("Unsupported diffuse irradiance lightmap version");
        var path = info.GetArray<string>("m_lightMaps").Single(p => p.EndsWith("/irradiance.vtex"));
        using var resource = loader.LoadFileCompiled(path)!;
        var texture = (Texture)resource.DataBlock!;
        uint mip = 0;
        while (mip + 1 < texture.NumMipLevels && (texture.Width >> (int)mip) * (texture.Height >> (int)mip) > 4096 * 4096) mip++;
        var width = Math.Max(4, texture.Width >> (int)mip); var height = Math.Max(4, texture.Height >> (int)mip);
        if (texture.Format.ToString() != "BC6H" || texture.Depth != 1 ||
            width % 4 != 0 || height % 4 != 0 || width * height > 4096 * 4096)
            throw new InvalidDataException("Expected a bounded authored BC6H unsigned irradiance mip");
        var blocks = new byte[texture.CalculateBufferSizeForMipLevel(mip)];
        if (blocks.Length != width * height) throw new InvalidDataException("Invalid BC6H irradiance mip size");
        texture.ReadTextureMipLevel(blocks, mip);
        const string file = "irradiance.bc6h.gz";
        using (var stream = File.Create(Path.Combine(folder, file)))
        using (var gzip = new GZipStream(stream, CompressionLevel.SmallestSize)) gzip.Write(blocks);
        var scale = world.GetLightmapUvScale();
        return new JsonObject {
            ["schema"] = 1, ["file"] = "render/" + file, ["format"] = "BC6H_UFLOAT",
            ["width"] = width, ["height"] = height, ["gpuBytes"] = blocks.Length,
            ["bytes"] = new FileInfo(Path.Combine(folder, file)).Length,
            ["uvScale"] = new JsonArray(scale.X, scale.Y), ["slice"] = 0,
            ["sourceMip"] = mip, ["flipY"] = false,
        };
    }
}
