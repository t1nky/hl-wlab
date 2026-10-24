using System.Numerics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using TinyBCSharp;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveResourceFormat.Utils;

// Static display geometry only. Sample the authored six-direction HDR probe volume
// once at import, keeping its large 3D atlas and all decoding out of the browser.
internal sealed class RenderProbes
{
  private sealed record Probe(int Handshake, int Priority, Matrix4x4 WorldToLocal, Vector3 Min, Vector3 Size,
      Vector3 AtlasSize, Vector3 AtlasOffset, Volume Irradiance, Volume Shadows);

  private sealed class Volume
  {
    public readonly int Width, Height, Depth;
    private readonly byte[] blocks;
    private readonly bool hdr;
    private readonly BlockDecoder decoder;
    private readonly Dictionary<int, Vector4[]> decoded = [];
    private readonly Queue<int> order = [];
    public Volume(Texture texture, bool hdr)
    {
      Width = texture.Width; Height = texture.Height; Depth = texture.Depth; this.hdr = hdr;
      if (Width % 4 != 0 || Height % 4 != 0 || Width <= 0 || Height <= 0 || Depth <= 0 ||
          texture.Format.ToString() != (hdr ? "BC6H" : "BC7")) throw new InvalidDataException("Unsupported light probe texture");
      blocks = new byte[texture.CalculateBufferSizeForMipLevel(0)];
      if (blocks.Length != checked(Width * Height * Depth)) throw new InvalidDataException("Invalid light probe block count");
      texture.ReadTextureMipLevel(blocks, 0);
      decoder = BlockDecoder.Create(hdr ? BlockFormat.BC6HUf32 : BlockFormat.BC7);
    }
    private Vector4 Texel(int x, int y, int z)
    {
      x = Math.Clamp(x, 0, Width - 1); y = Math.Clamp(y, 0, Height - 1); z = Math.Clamp(z, 0, Depth - 1);
      var key = (z * (Height / 4) + y / 4) * (Width / 4) + x / 4;
      if (!decoded.TryGetValue(key, out var pixels))
      {
        Span<byte> data = stackalloc byte[256];
        decoder.Decode(blocks.AsSpan(key * 16, 16), 4, 4, data[..(hdr ? 256 : 64)], 4, 4);
        pixels = new Vector4[16];
        if (hdr) MemoryMarshal.Cast<byte, Vector4>(data).CopyTo(pixels);
        else for (var i = 0; i < 16; i++) pixels[i] = new Vector4(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]) / 255;
        if (decoded.Count >= 8192) decoded.Remove(order.Dequeue());
        decoded.Add(key, pixels); order.Enqueue(key);
      }
      return pixels[(y % 4) * 4 + x % 4];
    }
    public Vector4 Sample(Vector3 uv)
    {
      var p = uv * new Vector3(Width, Height, Depth) - new Vector3(0.5f);
      var x = (int)MathF.Floor(p.X); var y = (int)MathF.Floor(p.Y); var z = (int)MathF.Floor(p.Z);
      var f = p - new Vector3(x, y, z);
      Vector4 Row(int yy, int zz) => Vector4.Lerp(Texel(x, yy, zz), Texel(x + 1, yy, zz), f.X);
      return Vector4.Lerp(Vector4.Lerp(Row(y, z), Row(y + 1, z), f.Y), Vector4.Lerp(Row(y, z + 1), Row(y + 1, z + 1), f.Y), f.Z);
    }
  }

  private readonly Probe[] probes;
  private readonly int channel;
  public int Vertices { get; private set; }
  public int Primitives { get; private set; }
  private RenderProbes(Probe[] probes, int channel) { this.probes = probes; this.channel = channel; }

  public static RenderProbes? Load(World world, GameFileLoader loader)
  {
    var info = world.GetWorldLightingInfo();
    if (info.GetInt32Property("m_nLightmapVersionNumber") != 8 || info.GetInt32Property("m_nLightmapGameVersionNumber") != 2 ||
        info.GetBooleanProperty("m_bBakedShadowsGamma20")) throw new InvalidDataException("Unsupported light probe bake version");
    var entities = new List<EntityLump.Entity>(); var visited = new HashSet<string>();
    void Visit(string name)
    {
      if (!visited.Add(name)) return;
      using var resource = loader.LoadFileCompiled(name)!; var lump = (EntityLump)resource.DataBlock!;
      entities.AddRange(lump.GetEntities());
      foreach (var child in lump.GetChildEntityNames()) Visit(child);
    }
    foreach (var name in world.GetEntityLumpNames()) Visit(name);
    var source = entities.Where(e => e.GetStringProperty("classname") is "env_combined_light_probe_volume" or "env_light_probe_volume").ToArray();
    if (source.Length == 0) return null;
    var sun = entities.Single(e => e.GetStringProperty("classname") == "light_environment");
    var hash = unchecked((uint)sun.GetIntegerProperty("light_path_uniqueid"));
    var binding = info.GetArray("m_bakedShadows")?.SingleOrDefault(b => b.GetUInt32Property("m_nLightHash") == hash);
    var channel = RenderSunBlocks.ResolveChannel(sun.GetInt32Property("bakedshadowindex", -1), binding?.GetInt32Property("m_nShadowChannel"));
    var volumes = new Dictionary<string, Volume>();
    Volume Texture(string path, bool hdr)
    {
      if (volumes.TryGetValue(path, out var result)) return result;
      using var resource = loader.LoadFileCompiled(path)!; result = new Volume((Texture)resource.DataBlock!, hdr);
      volumes.Add(path, result); return result;
    }
    var probes = source.Select(e =>
    {
      if (!e.ContainsKey("light_probe_atlas_x")) throw new InvalidDataException("Individual light probes are not yet supported");
      if (!Matrix4x4.Invert(EntityTransformHelper.ToTransformationMatrix(e), out var inverse)) throw new InvalidDataException("Singular light probe transform");
      var min = e.GetVector3Property("box_mins"); var size = e.GetVector3Property("box_maxs") - min;
      var atlasSize = new Vector3(e.GetFloatProperty("light_probe_size_x"), e.GetFloatProperty("light_probe_size_y"), e.GetFloatProperty("light_probe_size_z"));
      var atlasOffset = new Vector3(e.GetFloatProperty("light_probe_atlas_x"), e.GetFloatProperty("light_probe_atlas_y"), e.GetFloatProperty("light_probe_atlas_z"));
      if (Vector3.Min(size, atlasSize) is var smallest && (smallest.X <= 0 || smallest.Y <= 0 || smallest.Z <= 0)) throw new InvalidDataException("Invalid light probe bounds");
      var irradiance = Texture(e.GetStringProperty("lightprobetexture")!, true);
      var shadows = Texture(e.GetStringProperty("lightprobetexture_dlshd")!, false);
      if (irradiance.Width != shadows.Width || irradiance.Height != shadows.Height || irradiance.Depth != shadows.Depth * 6 ||
          atlasOffset.X < 0 || atlasOffset.Y < 0 || atlasOffset.Z < 0 || atlasOffset.X + atlasSize.X > shadows.Width ||
          atlasOffset.Y + atlasSize.Y > shadows.Height || atlasOffset.Z + atlasSize.Z > shadows.Depth) throw new InvalidDataException("Invalid light probe atlas placement");
      return new Probe(e.GetInt32Property("handshake"), e.GetInt32Property("indoor_outdoor_level"), inverse, min, size,
          atlasSize, atlasOffset, irradiance, shadows);
    }).OrderByDescending(p => p.Priority).ThenBy(p => p.AtlasSize.LengthSquared()).ToArray();
    return new RenderProbes(probes, channel);
  }

  private Probe Select(Vector3 position, int handshake)
  {
    var exact = handshake == 0 ? null : probes.FirstOrDefault(p => p.Handshake == handshake);
    if (exact != null) return exact;
    return probes.FirstOrDefault(p =>
    {
      var local = (Vector3.Transform(position, p.WorldToLocal) - p.Min) / p.Size;
      return local.X >= 0 && local.Y >= 0 && local.Z >= 0 && local.X <= 1 && local.Y <= 1 && local.Z <= 1;
    }) ?? probes[^1];
  }

  private Vector4 Sample(Probe probe, Vector3 position, Vector3 normal)
  {
    var local = (Vector3.Transform(position, probe.WorldToLocal) - probe.Min) / probe.Size;
    var dims = new Vector3(probe.Shadows.Width, probe.Shadows.Height, probe.Shadows.Depth);
    var shadowUv = RenderProbeMath.Coordinates(local, dims, probe.AtlasSize, probe.AtlasOffset, false);
    var indirect = RenderProbeMath.Coordinates(local, dims, probe.AtlasSize, probe.AtlasOffset, true);
    Vector3 Face(int face)
    {
      var uv = indirect; uv.Z += face / 6f;
      var value = probe.Irradiance.Sample(uv); return new Vector3(value.X, value.Y, value.Z);
    }
    var rgb = RenderProbeMath.Ambient(normal, Face);
    var shadow = probe.Shadows.Sample(shadowUv);
    var visibility = 1 - (channel switch { 0 => shadow.X, 1 => shadow.Y, 2 => shadow.Z, _ => shadow.W });
    if (!float.IsFinite(rgb.X + rgb.Y + rgb.Z + visibility)) throw new InvalidDataException("Nonfinite probe lighting");
    return new Vector4(rgb, Math.Clamp(visibility, 0, 1));
  }

  public void Bake(JsonObject gltf, string folder, string basename)
  {
    var buffers = gltf["buffers"]!.AsArray().Select(b => File.ReadAllBytes(Path.Combine(folder, b!["uri"]!.GetValue<string>()))).ToArray();
    Vector3 Read(int accessorIndex, int vertex)
    {
      var a = gltf["accessors"]![accessorIndex]!; var view = gltf["bufferViews"]![a["bufferView"]!.GetValue<int>()]!;
      if (a["componentType"]!.GetValue<int>() != 5126 || a["type"]!.GetValue<string>() != "VEC3") throw new InvalidDataException("Unsupported probe source vertex format");
      var at = (view["byteOffset"]?.GetValue<int>() ?? 0) + (a["byteOffset"]?.GetValue<int>() ?? 0) + vertex * (view["byteStride"]?.GetValue<int>() ?? 12);
      return MemoryMarshal.Read<Vector3>(buffers[view["buffer"]!.GetValue<int>()].AsSpan(at, 12));
    }
    var conversion = Matrix4x4.CreateScale(0.0254f) * Matrix4x4.CreateFromQuaternion(Quaternion.CreateFromYawPitchRoll(0, -MathF.PI / 2, -MathF.PI / 2));
    Matrix4x4.Invert(conversion, out var toSource);
    var file = basename + ".probes.bin";
    using var stream = File.Create(Path.Combine(folder, file));
    using var writer = new BinaryWriter(stream);
    var bufferIndex = gltf["buffers"]!.AsArray().Count;
    var meshes = gltf["meshes"]!.AsArray();
    (byte[] Data, int Start, int Stride, int Size, int Count, int Type) Accessor(int index)
    {
      var a = gltf["accessors"]![index]!; var view = gltf["bufferViews"]![a["bufferView"]!.GetValue<int>()]!;
      var type = a["componentType"]!.GetValue<int>(); var bytes = type switch { 5121 => 1, 5123 => 2, 5125 or 5126 => 4, _ => throw new InvalidDataException("Unsupported probe accessor type") };
      var components = a["type"]!.GetValue<string>() switch { "SCALAR" => 1, "VEC2" => 2, "VEC3" => 3, "VEC4" => 4, _ => throw new InvalidDataException("Unsupported probe accessor shape") };
      return (buffers[view["buffer"]!.GetValue<int>()], (view["byteOffset"]?.GetValue<int>() ?? 0) + (a["byteOffset"]?.GetValue<int>() ?? 0), view["byteStride"]?.GetValue<int>() ?? bytes * components, bytes * components, a["count"]!.GetValue<int>(), type);
    }
    int AddAccessor(JsonNode original, long start, int count, int bytes)
    {
      var view = gltf["bufferViews"]!.AsArray().Count;
      gltf["bufferViews"]!.AsArray().Add(new JsonObject { ["buffer"] = bufferIndex, ["byteOffset"] = start, ["byteLength"] = (long)bytes });
      var accessor = original.DeepClone(); accessor["bufferView"] = view; accessor["byteOffset"] = 0; accessor["count"] = count;
      accessor.AsObject().Remove("min"); accessor.AsObject().Remove("max");
      var index = gltf["accessors"]!.AsArray().Count; gltf["accessors"]!.AsArray().Add(accessor); return index;
    }
    void Node(int id, Matrix4x4 parent)
    {
      var node = gltf["nodes"]![id]!;
      Matrix4x4 local;
      if (node["matrix"] is JsonArray matrix)
      {
        var a = matrix.Select(v => v!.GetValue<float>()).ToArray();
        local = new Matrix4x4(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], a[13], a[14], a[15]);
      }
      else
      {
        float[] Values(string key, float[] fallback) => node[key] is JsonArray a ? a.Select(v => v!.GetValue<float>()).ToArray() : fallback;
        var t = Values("translation", [0, 0, 0]); var r = Values("rotation", [0, 0, 0, 1]); var s = Values("scale", [1, 1, 1]);
        local = Matrix4x4.CreateScale(s[0], s[1], s[2]) * Matrix4x4.CreateFromQuaternion(new Quaternion(r[0], r[1], r[2], r[3])) * Matrix4x4.CreateTranslation(t[0], t[1], t[2]);
      }
      var world = local * parent;
      if (node["mesh"] is JsonNode mi)
      {
        var mesh = meshes[mi.GetValue<int>()]!;
        if (mesh["primitives"]!.AsArray().Any(p => p!["extras"]?["cs2Lighting"]?["mode"]?.GetValue<string>() == "probe"))
        {
          // Instances may share geometry but sample different world positions.
          mesh = mesh.DeepClone(); node["mesh"] = meshes.Count; meshes.Add(mesh);
          var transform = world * toSource;
          if (!Matrix4x4.Invert(transform, out var inverse)) throw new InvalidDataException("Singular prop transform");
          var normalTransform = Matrix4x4.Transpose(inverse);
          foreach (var p in mesh["primitives"]!.AsArray())
          {
            var binding = p!["extras"]?["cs2Lighting"];
            if (binding?["mode"]?.GetValue<string>() != "probe") continue;
            var attrs = p["attributes"]!; var positions = attrs["POSITION"]!.GetValue<int>(); var normals = attrs["NORMAL"]!.GetValue<int>();
            var min = gltf["accessors"]![positions]!["min"]!.AsArray(); var max = gltf["accessors"]![positions]!["max"]!.AsArray();
            // The exporter may share whole-map accessors between tiny primitives.
            // Compact before sampling; never visit those unreferenced vertices.
            var ix = Accessor(p["indices"]!.GetValue<int>()); var used = new List<int>(); var indices = new uint[ix.Count]; var vertexMap = new Dictionary<int, uint>();
            var boundsMin = new Vector3(float.PositiveInfinity); var boundsMax = new Vector3(float.NegativeInfinity);
            for (var i = 0; i < ix.Count; i++)
            {
              var bytes = ix.Data.AsSpan(ix.Start + i * ix.Stride, ix.Size);
              var old = checked((int)(ix.Type switch { 5121 => bytes[0], 5123 => MemoryMarshal.Read<ushort>(bytes), 5125 => MemoryMarshal.Read<uint>(bytes), _ => throw new InvalidDataException("Invalid probe index") }));
              if (!vertexMap.TryGetValue(old, out var next)) { next = (uint)used.Count; vertexMap.Add(old, next); used.Add(old); var position = Read(positions, old); boundsMin = Vector3.Min(boundsMin, position); boundsMax = Vector3.Max(boundsMax, position); }
              indices[i] = next;
            }
            var probe = Select(Vector3.Transform((boundsMin + boundsMax) / 2, transform), binding["probeHandshake"]?.GetValue<int>() ?? 0);
            var indexAt = stream.Position; foreach (var index in indices) writer.Write(index);
            p["indices"] = AddAccessor(new JsonObject { ["componentType"] = 5125, ["type"] = "SCALAR" }, indexAt, indices.Length, indices.Length * 4);
            foreach (var pair in attrs.AsObject().ToArray())
            {
              var oldAccessor = pair.Value!.GetValue<int>(); var a = Accessor(oldAccessor); var at = stream.Position;
              foreach (var vertex in used) { if (vertex >= a.Count) throw new InvalidDataException("Probe index out of bounds"); writer.Write(a.Data, a.Start + vertex * a.Stride, a.Size); }
              while (stream.Position % 4 != 0) writer.Write((byte)0);
              attrs[pair.Key] = AddAccessor(gltf["accessors"]![oldAccessor]!, at, used.Count, used.Count * a.Size);
              if (pair.Key == "POSITION") { gltf["accessors"]![attrs[pair.Key]!.GetValue<int>()]!["min"] = min.DeepClone(); gltf["accessors"]![attrs[pair.Key]!.GetValue<int>()]!["max"] = max.DeepClone(); }
            }
            var count = used.Count; var lightAt = stream.Position;
            foreach (var v in used)
            {
              var pos = Vector3.Transform(Read(positions, v), transform); var normal = Vector3.Normalize(Vector3.TransformNormal(Read(normals, v), normalTransform));
              var light = Sample(probe, pos, normal); writer.Write(light.X); writer.Write(light.Y); writer.Write(light.Z); writer.Write(light.W);
            }
            var view = gltf["bufferViews"]!.AsArray().Count;
            gltf["bufferViews"]!.AsArray().Add(new JsonObject { ["buffer"] = bufferIndex, ["byteOffset"] = lightAt, ["byteLength"] = (long)count * 16 });
            attrs["_CS2_PROBE_LIGHT"] = gltf["accessors"]!.AsArray().Count;
            gltf["accessors"]!.AsArray().Add(new JsonObject { ["bufferView"] = view, ["componentType"] = 5126, ["count"] = count, ["type"] = "VEC4" });
            binding["storage"] = "linear-irradiance-sun-visibility"; Vertices += count; Primitives++;
          }
        }
      }
      if (node["children"] is JsonArray children) foreach (var child in children) Node(child!.GetValue<int>(), world);
    }
    foreach (var root in gltf["scenes"]![gltf["scene"]?.GetValue<int>() ?? 0]!["nodes"]!.AsArray()) Node(root!.GetValue<int>(), Matrix4x4.Identity);
    writer.Flush();
    gltf["buffers"]!.AsArray().Add(new JsonObject { ["uri"] = file, ["byteLength"] = stream.Length });
    // Remove unreferenced originals so they cannot retain duplicate geometry.
    var used = gltf["nodes"]!.AsArray().Where(n => n?["mesh"] != null).Select(n => n!["mesh"]!.GetValue<int>()).ToHashSet();
    var remap = new Dictionary<int, int>(); var kept = new JsonArray();
    for (var i = 0; i < meshes.Count; i++) if (used.Contains(i)) { remap[i] = kept.Count; kept.Add(meshes[i]!.DeepClone()); }
    foreach (var n in gltf["nodes"]!.AsArray()) if (n?["mesh"] != null) n["mesh"] = remap[n["mesh"]!.GetValue<int>()];
    gltf["meshes"] = kept;
  }
}
