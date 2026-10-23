internal static class RenderSunBlocks
{
    // BC5U is two consecutive BC4U blocks per 4x4 tile. The sun owns channel zero.
    // Extract bytes verbatim: no image resize, row flip, endpoint change or gamma.
    public static byte[] ExtractRed(ReadOnlySpan<byte> bc5)
    {
        if (bc5.Length == 0 || bc5.Length % 16 != 0) throw new InvalidDataException("Invalid BC5 sun atlas");
        var bc4 = new byte[bc5.Length / 2];
        for (var src = 0; src < bc5.Length; src += 16) bc5.Slice(src, 8).CopyTo(bc4.AsSpan(src / 2, 8));
        return bc4;
    }
}
