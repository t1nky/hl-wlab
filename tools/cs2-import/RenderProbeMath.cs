using System.Numerics;

// Source's six directional lobes use squared world-normal weights. Values are HDR,
// and atlas borders are clamped before scale/offset, not after interpolation.
internal static class RenderProbeMath
{
  public static Vector3 Coordinates(Vector3 local, Vector3 dimensions, Vector3 size, Vector3 offset, bool indirect)
  {
    var half = new Vector3(0.5f);
    var clamped = indirect
        ? Vector3.Clamp(local, half / dimensions, (dimensions - half) / dimensions)
        : Vector3.Clamp(local, Vector3.Zero, Vector3.One);
    var result = (clamped * size + offset) / dimensions;
    if (indirect) result.Z /= 6;
    return result;
  }

  public static Vector3 Ambient(Vector3 normal, Func<int, Vector3> face) =>
      face(normal.X > 0 ? 0 : 3) * normal.X * normal.X +
      face(normal.Y > 0 ? 1 : 4) * normal.Y * normal.Y +
      face(normal.Z > 0 ? 2 : 5) * normal.Z * normal.Z;
}
