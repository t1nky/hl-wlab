using System.Numerics;

var checks = 0;
var sourceBlocks = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
var sunBlocks = RenderSunBlocks.ExtractRed(sourceBlocks);
if (!sunBlocks.SequenceEqual(sourceBlocks[..8].Concat(sourceBlocks[16..24]).Concat(sourceBlocks[32..40]).Concat(sourceBlocks[48..56])))
    throw new Exception("Sun BC4 must preserve red blocks and tile orientation exactly, excluding green");
checks++;
try { RenderSunBlocks.ExtractRed(new byte[17]); throw new Exception("Accepted truncated BC5"); }
catch (InvalidDataException) { checks++; }
void Near(Vector3 actual, Vector3 expected, string label) {
    if (!float.IsFinite(actual.X + actual.Y + actual.Z) || Vector3.Distance(actual, expected) > 1e-5f)
        throw new Exception($"{label}: {actual} != {expected}");
    checks++;
}
var wood = new Vector3(0.25f, 0.18f, 0.1f);
if (RenderVisibility.IsStaticSurface("csgo_effects.vfx", false) || RenderVisibility.IsStaticSurface("csgo_environment.vfx", true) ||
    !RenderVisibility.IsStaticSurface("csgo_environment.vfx", false)) throw new Exception("Atmospheric effects/tools must not become static surfaces");
checks++;
Near(RenderTint.Apply(wood, Vector3.Zero, 1, 0), wood, "A black instance leaves unmasked wood visible");
Near(RenderTint.Apply(wood, Vector3.Zero, 1, 1), Vector3.Zero, "A fully masked black tint can still darken a texel");
Near(RenderTint.Apply(wood, Vector3.Zero, 1, 0.5f), wood / 2, "Partial masks retain grain and color");
Near(RenderTint.Apply(wood, Vector3.One, 1, 1), wood, "White tint is neutral");
Near(RenderTint.Apply(wood, Vector3.Zero, 0, 1), wood, "Disabled model tint is neutral");
var plaster = new Vector3(0.6f, 0.55f, 0.44f);
var redInstance = new Vector3(0.27889422f, 0.02732079f, 0.02732079f);
Near(RenderTint.Apply(plaster, redInstance, 0, 1), plaster, "Inferno notint plaster ignores saturated object color");
Near(RenderTint.Apply(plaster, redInstance, 1, 0), plaster, "Unmasked plaster retains cream even for a red object");
Near(RenderTint.Correct(wood, RenderTint.ColorCorrection(Vector3.One, plaster), RenderTint.ColorTint(Vector3.One), true, 1), wood, "Default material correction is neutral");
var brighten = RenderTint.ColorCorrection(new Vector3(1, 1, 1.6f), plaster);
Near(RenderTint.Correct(wood, brighten, Matrix4x4.Identity, false, 0), wood, "Color correction mode zero leaves unmasked texels intact");
Near(RenderTint.Correct(wood, brighten, Matrix4x4.Identity, false, 1), wood * 1.6f, "Material brightness affects masked texels");
Near(RenderTint.Correct(wood, brighten, Matrix4x4.Identity, true, 0), wood * 1.6f, "Mode one also corrects unmasked texels");
Near(RenderTint.Correct(wood, RenderTint.ColorCorrection(new Vector3(0.5f, 1, 1), plaster), Matrix4x4.Identity, true, 0), Vector3.Lerp(plaster, wood, 0.5f), "Contrast pivots on texture reflectivity, not middle gray");
Near(RenderTint.Correct(wood, Matrix4x4.CreateTranslation(plaster), Matrix4x4.Identity, true, 0, 0.25f), wood + plaster * 0.25f, "Affine correction scales translation by original sampled color alpha");
foreach (var amount in new[] { 0.25f, 0.7f, 1f }) {
    var modelSrgb = new Vector3(0.3f, 0.6f, 0.9f);
    var materialSrgb = new Vector3(0.8f, 0.7f, 0.6f);
    var exported = RenderTint.Linear(Vector3.Lerp(Vector3.One, modelSrgb, amount) * materialSrgb);
    Near(RenderTint.RecoverModelTint(exported, materialSrgb, amount), RenderTint.Linear(modelSrgb), "Recover object tint without baking material tint twice");
}
Near(RenderTint.RecoverModelTint(Vector3.Zero, Vector3.One, 1), Vector3.Zero, "Black is a valid tint, not a missing-data sentinel");
Near(RenderTint.Linear(RenderTint.Srgb(wood)), wood, "Texture color space round trip");
if (RenderTint.Mask(0, 1, 1) != 0 || RenderTint.Mask(1, 1, 1) != 1 || RenderTint.Mask(0.5f, 2, 0.5f) != 0.25f)
    throw new Exception("Tint mask channel/contrast/brightness mismatch");
checks++;
Console.WriteLine($"Render tint/sun block tests: {checks} passed (no game files required).");
