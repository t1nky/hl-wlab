using System.Diagnostics;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SteamDatabase.ValvePak;
using ValveKeyValue;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveResourceFormat.Utils;

// Only reads the user's installation. All outputs must stay under the repo's ignored .local.
if (args.Length < 2) throw new ArgumentException("Usage: Cs2Import <CS2 installation> <repo .local/cs2 directory> [--force]");
var timer = Stopwatch.StartNew();
var game = Path.GetFullPath(args[0]);
var output = Path.GetFullPath(args[1]);
var repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));
var allowed = Path.Combine(repo, ".local", "cs2") + Path.DirectorySeparatorChar;
if (!(output + Path.DirectorySeparatorChar).StartsWith(allowed, StringComparison.OrdinalIgnoreCase))
  throw new ArgumentException("Output must be under this repo's .local/cs2");
Directory.CreateDirectory(output);
const string map = "de_inferno";
const int schema = 1;
var csgo = Path.Combine(game, "game", "csgo");
var mapPath = Path.Combine(csgo, "maps", map + ".vpk");
var steamInf = File.ReadAllText(Path.Combine(csgo, "steam.inf"));
var sources = new[] { mapPath }.Concat(new[] { csgo, Path.Combine(game, "game", "core") }
    .SelectMany(d => Directory.EnumerateFiles(d, "pak*.vpk"))).Order().Select(p =>
    {
      var f = new FileInfo(p); return $"{f.FullName}|{f.Length}|{f.LastWriteTimeUtc.Ticks}";
    });
var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
    $"{schema}|VRF20.1.7467|{steamInf}|{string.Join('\n', sources)}|{File.ReadAllText(Path.Combine(repo, "tools/cs2-import/Program.cs"))}")));
var manifestPath = Path.Combine(output, "map.json");
if (args.Contains("--render")) RenderExport.Prepare(mapPath, output, fingerprint, args.Contains("--force"));
if (!args.Contains("--force") && File.Exists(manifestPath) && File.Exists(Path.Combine(output, "map.cs2map")))
{
  using var old = JsonDocument.Parse(File.ReadAllText(manifestPath));
  if (old.RootElement.GetProperty("fingerprint").GetString() == fingerprint)
  {
    Console.WriteLine($"Cached Inferno package valid ({timer.Elapsed.TotalMilliseconds:F0} ms)."); return;
  }
}
using var package = new Package(); package.Read(mapPath);
using var loader = new GameFileLoader(package, mapPath);
loader.EnsureStringTokenGameKeys();
byte[] ReadRaw(string path)
{
  var found = loader.FindFile(path);
  if (found.PathOnDisk != null) return File.ReadAllBytes(found.PathOnDisk);
  if (found.Package == null || found.PackageEntry == null) throw new FileNotFoundException(path);
  found.Package.ReadEntry(found.PackageEntry, out var bytes); return bytes;
}
var surfaceBytes = ReadRaw("scripts/surfaceproperties_game.txt");
var weaponBytes = ReadRaw("scripts/weapons.vdata_c");
var surfaceGame = KVSerializer.Create(KVSerializationFormat.KeyValues3Text).Deserialize(new MemoryStream(surfaceBytes));
using var surfacesResource = loader.LoadFileCompiled("surfaceproperties/surfaceproperties.vsurf")!;
var baseSurfaces = ((BinaryKV3)surfacesResource.DataBlock!).Data.Root.GetArray("SurfacePropertiesList");
var games = surfaceGame.Root.GetArray("SurfacePropertiesList").ToDictionary(s => s.GetStringProperty("surfacePropertyName"), StringComparer.OrdinalIgnoreCase);
var bases = baseSurfaces.ToDictionary(s => s.GetStringProperty("surfacePropertyName"), StringComparer.OrdinalIgnoreCase);
Dictionary<string, object> ResolveSurface(string name, HashSet<string>? visited = null)
{
  visited ??= new(StringComparer.OrdinalIgnoreCase);
  if (!visited.Add(name)) throw new InvalidDataException("Cyclic surface inheritance: " + name);
  var values = new Dictionary<string, object>();
  if (bases.TryGetValue(name, out var surface))
  {
    var parent = surface.GetStringProperty("base");
    if (!string.IsNullOrEmpty(parent)) values = ResolveSurface(parent, visited);
  }
  if (games.TryGetValue(name, out var g))
  {
    foreach (var key in new[] { "bulletPenetrationDistanceModifier", "bulletPenetrationDamageModifier" })
      if (g.ContainsKey(key)) values[key] = g.GetFloatProperty(key);
    if (g.ContainsKey("gamematerial")) values["gameMaterial"] = g.GetStringProperty("gamematerial");
  }
  return values;
}
using var weaponResource = loader.LoadFileCompiled("scripts/weapons.vdata")!;
var awp = ((BinaryKV3)weaponResource.DataBlock!).Data.Root.GetSubCollection("weapon_awp");
var weapon = new
{
  name = "AWP",
  damage = awp.GetInt32Property("m_nDamage"),
  penetration = awp.GetFloatProperty("m_flPenetration"),
  range = awp.GetFloatProperty("m_flRange"),
  rangeModifier = awp.GetFloatProperty("m_flRangeModifier"),
  armorRatio = awp.GetFloatProperty("m_flArmorRatio"),
  headshotMultiplier = awp.GetFloatProperty("m_flHeadshotMultiplier")
};
var vertices = new List<Vector3>(); var indices = new List<uint>();
var triangleMaterials = new List<uint>(); var triangleShapes = new List<uint>();
var shapes = new List<object>(); var materials = new List<object>();
var materialIds = new Dictionary<uint, uint>();
var stats = new Dictionary<string, int>();
var warnings = new List<string>();
uint Material(uint hash)
{
  if (materialIds.TryGetValue(hash, out var id)) return id;
  id = (uint)materials.Count; materialIds[hash] = id;
  var name = StringToken.GetKnownString(hash);
  var data = ResolveSurface(name);
  materials.Add(new
  {
    name,
    hash,
    distanceModifier = data.GetValueOrDefault("bulletPenetrationDistanceModifier"),
    damageModifier = data.GetValueOrDefault("bulletPenetrationDamageModifier"),
    gameMaterial = data.GetValueOrDefault("gameMaterial")
  });
  return id;
}
void Count(string key, int n = 1) => stats[key] = stats.GetValueOrDefault(key) + n;
void AddPhysics(PhysAggregateData phys, Matrix4x4 placement, string source)
{
  var localMaterials = phys.SurfacePropertyHashes.Select(Material).ToArray();
  for (var p = 0; p < phys.Parts.Length; p++)
  {
    var transform = (phys.BindPose.Length > p ? phys.BindPose[p] : Matrix4x4.Identity) * placement;
    var part = phys.Parts[p].Shape;
    Count("unsupportedSpheres", part.Spheres.Length); Count("unsupportedCapsules", part.Capsules.Length);
    (string group, string[] tags, string[] exclude, bool bullet, bool player) Attributes(int i)
    {
      var a = phys.CollisionAttributes[i];
      var group = a.GetStringProperty("m_CollisionGroupString").ToLowerInvariant();
      var tags = a.GetArray<string>("m_InteractAsStrings") ?? a.GetArray<string>("m_PhysicsTagStrings") ?? [];
      var exclude = a.GetArray<string>("m_InteractExcludeStrings") ?? [];
      var bullet = (group == "default" && tags.Length == 0 || tags.Contains("window") || tags.Contains("sky"))
          && !exclude.Contains("bullet") && !tags.Contains("passbullets") && !tags.Any(t => t.Contains("clip") || t.Contains("trigger"));
      var player = !exclude.Contains("player") && (group == "default" && tags.Length == 0 || tags.Any(t => t is "playerclip" or "passbullets" or "window"));
      if (!bullet && !player) Count("excludedShapes");
      return (group, tags, exclude, bullet, player);
    }
    void Triangle(uint a, uint b, uint c, uint mat, uint shape)
    {
      var normal = Vector3.Cross(vertices[(int)b] - vertices[(int)a], vertices[(int)c] - vertices[(int)a]);
      if (normal.LengthSquared() < 1e-10f) { Count("degenerateTriangles"); return; }
      indices.Add(a); indices.Add(b); indices.Add(c); triangleMaterials.Add(mat); triangleShapes.Add(shape);
    }
    foreach (var mesh in part.Meshes)
    {
      var attr = Attributes(mesh.CollisionAttributeIndex); if (!attr.bullet && !attr.player) continue;
      var id = (uint)shapes.Count; var start = indices.Count / 3; var vertexBase = (uint)vertices.Count;
      foreach (var v in mesh.Shape.GetVertices()) vertices.Add(Vector3.Transform(v, transform));
      var triangles = mesh.Shape.GetTriangles(); var mats = mesh.Shape.Materials;
      if (mats.Length != 0 && mats.Length != triangles.Length) throw new InvalidDataException("Per-triangle material length mismatch");
      for (var i = 0; i < triangles.Length; i++)
      {
        var t = triangles[i]; Triangle(vertexBase + (uint)t.X, vertexBase + (uint)t.Y, vertexBase + (uint)t.Z,
            localMaterials[mats.Length > 0 ? mats[i] : mesh.SurfacePropertyIndex], id);
      }
      shapes.Add(new { kind = "mesh", source, attr.group, attr.tags, attr.exclude, attr.bullet, attr.player, firstTriangle = start, triangleCount = indices.Count / 3 - start, planes = Array.Empty<float[]>() });
      Count("meshes");
    }
    foreach (var hullDesc in part.Hulls)
    {
      var attr = Attributes(hullDesc.CollisionAttributeIndex); if (!attr.bullet && !attr.player) continue;
      var id = (uint)shapes.Count; var start = indices.Count / 3; var vertexBase = (uint)vertices.Count;
      var hull = hullDesc.Shape;
      var positions = hull.GetVertexPositions().ToArray().Select(v => Vector3.Transform(v, transform)).ToArray();
      vertices.AddRange(positions);
      var centroid = Vector3.Transform(hull.Centroid, transform);
      var edges = hull.GetEdges(); var planes = new List<float[]>();
      foreach (var face in hull.GetFaces())
      {
        var polygon = new List<int>(); var edge = face.Edge;
        do
        {
          polygon.Add(edges[edge].Origin); edge = edges[edge].Next;
          if (polygon.Count > 256) throw new InvalidDataException("Invalid hull half-edge ring");
        } while (edge != face.Edge);
        if (polygon.Count < 3) throw new InvalidDataException("Invalid hull face");
        var a = positions[polygon[0]]; var b = positions[polygon[1]]; var c = positions[polygon[2]];
        var n = Vector3.Normalize(Vector3.Cross(b - a, c - a));
        if (!float.IsFinite(n.X)) throw new InvalidDataException("Degenerate hull plane");
        var flip = Vector3.Dot(n, centroid - a) > 0; if (flip) n = -n;
        planes.Add([n.X, n.Y, n.Z, Vector3.Dot(n, a)]);
        for (var j = 1; j < polygon.Count - 1; j++) Triangle(vertexBase + (uint)polygon[0], vertexBase + (uint)polygon[flip ? j + 1 : j], vertexBase + (uint)polygon[flip ? j : j + 1], localMaterials[hullDesc.SurfacePropertyIndex], id);
      }
      shapes.Add(new { kind = "hull", source, attr.group, attr.tags, attr.exclude, attr.bullet, attr.player, firstTriangle = start, triangleCount = indices.Count / 3 - start, planes }); Count("hulls");
    }
  }
}
using var mapResource = loader.LoadFileCompiled($"maps/{map}.vmap")!;
var extract = new MapExtract(mapResource, loader);
var worldPhysics = extract.LoadWorldPhysics() ?? throw new InvalidDataException("No world collision data");
AddPhysics(worldPhysics, Matrix4x4.Identity, "world (baked world-space collision)");
using var worldResource = loader.LoadFileCompiled($"{extract.LumpFolder}/world.vwrld")!;
var world = (World)worldResource.DataBlock!;
// Baked props are already in world physics. Only separate Model placements can add collision.
foreach (var nodeName in world.GetWorldNodeNames())
{
  using var nodeResource = loader.LoadFileCompiled(nodeName + ".vwnod")!;
  var node = (WorldNode)nodeResource.DataBlock!;
  foreach (var sceneObject in node.SceneObjects)
  {
    var flags = sceneObject.GetEnumValue<ObjectTypeFlags>("m_nObjectTypeFlags", normalize: true);
    if (!flags.HasFlag(ObjectTypeFlags.Model) || flags.HasFlag(ObjectTypeFlags.BakedGeometry)) { Count("bakedSceneObjects"); continue; }
    var modelName = sceneObject.GetStringProperty("m_renderableModel"); if (string.IsNullOrEmpty(modelName)) continue;
    using var modelResource = loader.LoadFileCompiled(modelName);
    if (modelResource?.DataBlock is not Model model) { warnings.Add("Missing model: " + modelName); continue; }
    var physics = model.GetEmbeddedPhys(); Resource? referenced = null;
    if (physics == null)
    {
      var name = model.GetReferencedPhysNames().FirstOrDefault();
      if (name != null) { referenced = loader.LoadFileCompiled(name); physics = referenced?.DataBlock as PhysAggregateData; }
    }
    if (physics != null) { AddPhysics(physics, sceneObject.GetArray("m_vTransform").ToMatrix4x4(), modelName); Count("placedProps"); }
    else Count("propsWithoutPhysics");
    referenced?.Dispose();
  }
  Count("aggregateSceneObjects", node.AggregateSceneObjects.Count);
  foreach (var aggregate in node.AggregateSceneObjects)
  {
    var flags = aggregate.GetEnumValue<ObjectTypeFlags>("m_allFlags", normalize: true);
    if (!flags.HasFlag(ObjectTypeFlags.Model)) continue;
    var name = aggregate.GetStringProperty("m_renderableModel");
    using var aggregateResource = loader.LoadFileCompiled(name);
    if (aggregateResource?.DataBlock is Model aggregateModel &&
        (aggregateModel.GetEmbeddedPhys() != null || aggregateModel.GetReferencedPhysNames().Any()))
    {
      Count("unsupportedAggregatePhysics");
      warnings.Add("Aggregate with separate physics unsupported: " + name);
    }
    else Count("renderOnlyAggregates");
  }
}
var spawns = new List<object>(); var visitedLumps = new HashSet<string>();
void Entities(string lumpName)
{
  if (!visitedLumps.Add(lumpName)) return;
  using var lumpResource = loader.LoadFileCompiled(lumpName)!;
  var lump = (EntityLump)lumpResource.DataBlock!;
  foreach (var e in lump.GetEntities())
  {
    var classname = e.GetStringProperty("classname");
    if (classname is "info_player_terrorist" or "info_player_counterterrorist")
    {
      var v = e.GetVector3Property("origin"); spawns.Add(new { classname, origin = new[] { v.X, v.Y, v.Z } });
    }
    if (!string.IsNullOrEmpty(e.GetStringProperty("model"))) Count("entityModelsOmitted");
  }
  foreach (var child in lump.GetChildEntityNames()) Entities(child);
}
foreach (var lump in world.GetEntityLumpNames()) Entities(lump);
warnings.Add("Entity-driven doors, breakables and movable props are omitted; world and static prop physics only. No live state.");
if (stats.GetValueOrDefault("unsupportedSpheres") + stats.GetValueOrDefault("unsupportedCapsules") > 0) warnings.Add("Sphere/capsule shapes omitted; see counts.");
var binaryPath = Path.Combine(output, "map.cs2map");
using (var writer = new BinaryWriter(File.Create(binaryPath + ".tmp")))
{
  writer.Write(0x50325343u); writer.Write(vertices.Count); writer.Write(indices.Count); writer.Write(triangleMaterials.Count);
  foreach (var v in vertices) { writer.Write(v.X); writer.Write(v.Y); writer.Write(v.Z); }
  foreach (var i in indices) writer.Write(i);
  foreach (var i in triangleMaterials) writer.Write(i);
  foreach (var i in triangleShapes) writer.Write(i);
}
File.Move(binaryPath + ".tmp", binaryPath, true);
var sourceMapSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(mapPath)));
var sourceSurfaceSha256 = Convert.ToHexStringLower(SHA256.HashData(surfaceBytes));
var sourceWeaponSha256 = Convert.ToHexStringLower(SHA256.HashData(weaponBytes));
var binarySha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(binaryPath)));
var metadata = new
{
  schema,
  map,
  fingerprint,
  preparedAt = DateTime.UtcNow,
  prepareMs = timer.Elapsed.TotalMilliseconds,
  sourceMapSha256,
  sourceSurfaceSha256,
  sourceWeaponSha256,
  binarySha256,
  vrf = "20.1.7467 (MIT)",
  steamInf,
  units = "Source units; Z-up; source coordinates preserved",
  weapon,
  materials,
  shapes,
  stats,
  spawns,
  warnings,
  vertexCount = vertices.Count,
  triangleCount = indices.Count / 3,
  binaryBytes = new FileInfo(binaryPath).Length
};
File.WriteAllText(manifestPath + ".tmp", JsonSerializer.Serialize(metadata)); File.Move(manifestPath + ".tmp", manifestPath, true);
Console.WriteLine($"Prepared {map}: {vertices.Count:N0} vertices, {indices.Count / 3:N0} collision triangles, {shapes.Count:N0} shapes; {new FileInfo(binaryPath).Length / 1048576.0:F1} MiB in {timer.Elapsed.TotalSeconds:F2} s.");
Console.WriteLine(JsonSerializer.Serialize(stats));
foreach (var warning in warnings) Console.WriteLine("LIMIT: " + warning);
