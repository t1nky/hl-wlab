using System.Diagnostics;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SteamDatabase.ValvePak;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.ResourceTypes.ModelAnimation;

// Real installed hitboxes and frozen animation poses, not a generic player hull.
// Geometry/animation output is private game content and must stay in ignored .local.
internal static class PlayerExport
{
    public static void Prepare(string game, string output, bool force)
    {
        var timer = Stopwatch.StartNew();
        const string modelPath = "agents/models/tm_phoenix/tm_phoenix.vmdl_c";
        var vpk = Path.Combine(game, "game/csgo/pak01_dir.vpk");
        var info = new FileInfo(vpk);
        var steamInf = File.ReadAllText(Path.Combine(game, "game/csgo/steam.inf"));
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"VRF20.1.7467|{steamInf}|{info.Length}|{info.LastWriteTimeUtc.Ticks}|{File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/cs2-import/PlayerExport.cs"))}")));
        var file = Path.Combine(output, "player.json");
        if (!force && File.Exists(file)) {
            using var prior = JsonDocument.Parse(File.ReadAllText(file));
            if (prior.RootElement.GetProperty("fingerprint").GetString() == fingerprint) { Console.WriteLine("Cached player poses valid."); return; }
        }
        using var package = new Package(); package.Read(vpk);
        using var loader = new GameFileLoader(package, vpk);
        using var resource = loader.LoadFile(modelPath)!;
        var model = (Model)resource.DataBlock!;
        var skeleton = model.Skeleton;
        var hitboxes = model.HitboxSets["cstrike"];
        if (skeleton.Bones.Length < 20 || hitboxes.Length < 10) throw new InvalidDataException("Player model lacks a real skeleton/hitbox set");
        var animations = model.GetAllAnimations(loader).ToDictionary(a => a.Name, StringComparer.Ordinal);
        var clips = new List<object>();
        foreach (var crouch in new[] { false, true }) {
            var stem = crouch ? "idle_crouch" : "idle";
            var baseName = $"animation/anims/world/rifle/_default_rifle/{stem}_rifle.vnmclip";
            var additiveName = $"animation/anims/world/rifle/rifle_awp/{stem}_awp.vnmclip";
            var basis = animations[baseName]; var additive = animations[additiveName];
            var sourceSkeleton = Skeleton.FromSkeletonResource(loader, basis.TargetSkeletonName)!;
            if (basis.IsAdditive || !additive.IsAdditive || basis.TargetSkeletonName != additive.TargetSkeletonName)
                throw new InvalidDataException("Unexpected rifle/AWP clip composition");
            var retarget = new SkeletonRetargeter(skeleton, sourceSkeleton);
            if (!retarget.HasMappedBones) throw new InvalidDataException("Animation skeleton cannot drive player hitboxes");
            var frames = new List<object>();
            for (var frameIndex = 0; frameIndex < basis.FrameCount; frameIndex++) {
                var frame = new Frame(sourceSkeleton, []) { FrameIndex = frameIndex };
                basis.DecodeFrame(frame);
                var deltaFrame = new Frame(sourceSkeleton, []) { FrameIndex = Math.Min(frameIndex, additive.FrameCount - 1) };
                additive.DecodeFrame(deltaFrame);
                for (var b = 0; b < frame.Bones.Length; b++) {
                    var delta = additive.GetAdditiveDelta(b, deltaFrame.Bones[b]);
                    var bone = frame.Bones[b];
                    frame.Bones[b] = new FrameBone(bone.Position + delta.Position, bone.Scale + delta.Scale, bone.Angle * delta.Angle);
                }
                var world = new Matrix4x4[skeleton.Bones.Length];
                retarget.Retarget(frame, world);
                // Numerics row-vector matrix memory is the equivalent Three.js column-major transform.
                frames.Add(world.Select(m => new[] { m.M11,m.M12,m.M13,m.M14,m.M21,m.M22,m.M23,m.M24,m.M31,m.M32,m.M33,m.M34,m.M41,m.M42,m.M43,m.M44 }).ToArray());
            }
            clips.Add(new { name = crouch ? "AWP crouching idle" : "AWP standing idle", crouched = crouch, source = baseName, additive = additiveName, fps = basis.Fps, frames });
        }
        var data = new {
            schema = 1, fingerprint, model = modelPath, steamInf, units = "Source inches, Z up; origin at feet",
            bones = skeleton.Bones.Select(b => new { name = b.Name, parent = b.Parent?.Index ?? -1 }),
            hitboxes = hitboxes.Select(h => new {
                name = h.Name, bone = skeleton[h.BoneName]?.Index ?? throw new InvalidDataException("Unknown hitbox bone"), group = h.GroupId,
                kind = h.ShapeType.ToString().ToLowerInvariant(), min = new[] { h.MinBounds.X,h.MinBounds.Y,h.MinBounds.Z },
                max = new[] { h.MaxBounds.X,h.MaxBounds.Y,h.MaxBounds.Z }, radius = h.ShapeRadius, translationOnly = h.TranslationOnly,
            }), clips, prepareMs = timer.Elapsed.TotalMilliseconds,
            warnings = new[] { "Frozen rifle-base plus AWP-additive clips retargeted by VRF; live animation graph, aim pitch layers, IK and engine pose parity unverified." },
        };
        File.WriteAllText(file + ".tmp", JsonSerializer.Serialize(data)); File.Move(file + ".tmp", file, true);
        Console.WriteLine($"Player poses: {skeleton.Bones.Length} bones, {hitboxes.Length} hitboxes, {clips.Count} clips, {new FileInfo(file).Length:N0} bytes; {timer.Elapsed.TotalSeconds:F2} s.");
    }
}
