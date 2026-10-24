using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using ValveResourceFormat.ResourceTypes;

// Retain the installation's authored GPU blocks and mip chain, without recompression.
// PNG/WebP remains the portable fallback; shader-specific texture codecs stay on it.
internal static class RenderTextureBlocks
{
    public static JsonObject? Export(Texture texture, uint firstMip, string folder)
    {
        var format = texture.Format.ToString();
        if (format is not ("DXT1" or "BC7") || texture.Depth != 1 ||
            texture.Flags.ToString().Contains("CUBE") || texture.RetrieveCodecFromResourceEditInfo().ToString() != "None") return null;
        using var data = new MemoryStream();
        var levels = new JsonArray();
        for (var mip = firstMip; mip < texture.NumMipLevels; mip++) {
            var width = Math.Max(1, texture.Width >> (int)mip);
            var height = Math.Max(1, texture.Height >> (int)mip);
            var bytes = new byte[texture.CalculateBufferSizeForMipLevel(mip)];
            var expected = ((width + 3) / 4) * ((height + 3) / 4) * (format == "DXT1" ? 8 : 16);
            if (bytes.Length != expected) throw new InvalidDataException("Invalid authored color blocks");
            texture.ReadTextureMipLevel(bytes, mip);
            levels.Add(new JsonObject { ["width"] = width, ["height"] = height, ["offset"] = data.Length, ["bytes"] = bytes.Length });
            data.Write(bytes);
        }
        var blocks = data.ToArray();
        var hash = Convert.ToHexStringLower(SHA256.HashData(blocks));
        var file = "native-" + hash[..20] + (format == "DXT1" ? ".bc1.gz" : ".bc7.gz");
        var path = Path.Combine(folder, file);
        using (var stream = File.Create(path + ".tmp"))
        using (var gzip = new GZipStream(stream, CompressionLevel.SmallestSize)) gzip.Write(blocks);
        File.Move(path + ".tmp", path, true);
        return new JsonObject { ["schema"] = 1, ["file"] = "render/" + file,
            ["format"] = format == "DXT1" ? "BC1_RGB" : "BC7_RGBA", ["levels"] = levels,
            ["gpuBytes"] = blocks.Length, ["bytes"] = new FileInfo(path).Length };
    }
}
