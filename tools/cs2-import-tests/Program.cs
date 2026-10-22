using System.Numerics;

var checks = 0;
void Near(Vector3 actual, Vector3 expected, string label) {
    if (!float.IsFinite(actual.X + actual.Y + actual.Z) || Vector3.Distance(actual, expected) > 1e-5f)
        throw new Exception($"{label}: {actual} != {expected}");
    checks++;
}
var wood = new Vector3(0.25f, 0.18f, 0.1f);
Near(RenderTint.Apply(wood, Vector3.Zero, 1, 0), wood, "A black instance leaves unmasked wood visible");
Near(RenderTint.Apply(wood, Vector3.Zero, 1, 1), Vector3.Zero, "A fully masked black tint can still darken a texel");
Near(RenderTint.Apply(wood, Vector3.Zero, 1, 0.5f), wood / 2, "Partial masks retain grain and color");
Near(RenderTint.Apply(wood, Vector3.One, 1, 1), wood, "White tint is neutral");
Near(RenderTint.Apply(wood, Vector3.Zero, 0, 1), wood, "Disabled model tint is neutral");
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
Console.WriteLine($"Render tint tests: {checks} passed (no game files required).");
