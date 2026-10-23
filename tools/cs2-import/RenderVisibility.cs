// Atmospheric effects need animated masks, Fresnel and scene-depth feathering.
// Exporting their proxy polygons as diffuse surfaces creates opaque gray sheets.
// Keep the static analysis scene to world surfaces until those effects are supported.
internal static class RenderVisibility
{
    public static bool IsStaticSurface(string shader, bool toolsMaterial) =>
        !toolsMaterial && shader != "csgo_effects.vfx";
}
