using System.Numerics;

// Masked model-tint interpretation based on VRF's MIT-licensed csgo_environment shaders.
// Pure math shared with importer tests. This is appearance only, never collision/material IDs.
internal static class RenderTint
{
    public static float Linear(float srgb) => srgb <= 0.04045f ? srgb / 12.92f : MathF.Pow((srgb + 0.055f) / 1.055f, 2.4f);
    public static float Srgb(float linear) => linear <= 0.0031308f ? linear * 12.92f : 1.055f * MathF.Pow(linear, 1f / 2.4f) - 0.055f;
    public static Vector3 Linear(Vector3 value) => new(Linear(value.X), Linear(value.Y), Linear(value.Z));
    public static Vector3 Srgb(Vector3 value) => new(Srgb(value.X), Srgb(value.Y), Srgb(value.Z));
    public static Vector3 RecoverModelTint(Vector3 exportedLinear, Vector3 materialSrgb, float amount)
    {
        if (amount <= 0) return Vector3.One;
        // VRF exports Linear(Lerp(white, objectTint, amount) * materialTint).
        // Components hidden by a zero material tint cannot affect the final image.
        var safe = Vector3.Max(materialSrgb, new Vector3(1e-6f));
        return Linear(Vector3.Clamp((Srgb(exportedLinear) / safe - new Vector3(1 - amount)) / amount, Vector3.Zero, Vector3.One));
    }
    public static float Mask(float green, float contrast, float brightness) =>
        Math.Clamp(((green - 0.5f) * contrast + 0.5f) * brightness, 0, 1);
    public static Vector3 Apply(Vector3 color, Vector3 tint, float amount, float mask)
    {
        var norm = Vector3.Normalize(Vector3.Max(tint, new Vector3(0.001f)));
        var luma = Vector3.Dot(color, new Vector3(0.2125f, 0.7154f, 0.0721f));
        var normLuma = Vector3.Dot(norm, new Vector3(0.2125f, 0.7154f, 0.0721f));
        var high = Math.Max(tint.X, Math.Max(tint.Y, tint.Z));
        var low = Math.Min(tint.X, Math.Min(tint.Y, tint.Z));
        var tinted = norm * Math.Min(luma / normLuma, 3 * luma * high);
        return Vector3.Clamp(Vector3.Lerp(color, tinted, Math.Clamp(amount * (1 - low) * mask, 0, 1)), Vector3.Zero, Vector3.One);
    }
}
