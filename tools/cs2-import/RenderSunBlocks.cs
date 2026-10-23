internal static class RenderSunBlocks
{
    public static int ResolveChannel(int entityChannel, int? worldChannel)
    {
        // The renderer uses the light entity's stationary index. Some maps omit
        // the optional world lookup; when present it must agree with that index.
        if (entityChannel is < 0 or > 3 || worldChannel is not null && worldChannel != entityChannel)
            throw new InvalidDataException("Invalid or mismatched sun baked shadow channel");
        return entityChannel;
    }

    // Maps choose BC4, BC5 or BC7 independently of the lighting schema. Preserve
    // native blocks; extracting a BC5 channel is exact, recompressing BC7 is not.
    public static (string Format, string Extension, byte[] Data, int Channel) Select(
        string format, ReadOnlySpan<byte> source, int channel)
    {
        if (format == "ATI1N" && channel == 0 && source.Length > 0 && source.Length % 8 == 0)
            return ("BC4_UNORM", "bc4", source.ToArray(), 0);
        if (format == "ATI2N" && channel is >= 0 and <= 1)
            return ("BC4_UNORM", "bc4", ExtractChannel(source, channel), 0);
        if (format == "BC7" && channel is >= 0 and <= 3 && source.Length > 0 && source.Length % 16 == 0)
            return ("BC7_UNORM", "bc7", source.ToArray(), channel);
        throw new InvalidDataException($"Unsupported sunlight atlas format/channel: {format}/{channel}");
    }

    // BC5U is two consecutive BC4U channel blocks per 4x4 tile.
    // Extract bytes verbatim: no image resize, row flip, endpoint change or gamma.
    public static byte[] ExtractRed(ReadOnlySpan<byte> bc5) => ExtractChannel(bc5, 0);
    private static byte[] ExtractChannel(ReadOnlySpan<byte> bc5, int channel)
    {
        if (bc5.Length == 0 || bc5.Length % 16 != 0) throw new InvalidDataException("Invalid BC5 sun atlas");
        var bc4 = new byte[bc5.Length / 2];
        for (var src = 0; src < bc5.Length; src += 16) bc5.Slice(src + channel * 8, 8).CopyTo(bc4.AsSpan(src / 2, 8));
        return bc4;
    }
}
