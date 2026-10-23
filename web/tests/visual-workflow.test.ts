import assert from 'node:assert/strict';
import * as THREE from 'three';
import { test } from 'vitest';
import { cs2Lighting } from '../src/render/lighting';
import { updatePointGeometry } from '../src/render/points';
import { viewPixelRatio } from '../src/render/quality';
import { disposeGroup } from '../src/render/resources';
import { setMapShadows } from '../src/render/shadows';

test('point reclassification reuses GPU attributes/bounds; changed scan source refreshes spatial data', () => {
  const data = {
    positions: new Float32Array([1, 2, 3, 4, 5, 6]),
    hp: new Float32Array([30, 50]),
    kind: new Float32Array([1, 2]),
  };
  const geometry = updatePointGeometry(new THREE.BufferGeometry(), data);
  const position = geometry.getAttribute('position'),
    hp = geometry.getAttribute('hp');
  assert.ok(position instanceof THREE.BufferAttribute);
  const sphere = geometry.boundingSphere;
  const changed = {
    positions: new Float32Array([100, 200, 300, 4, 5, 6]),
    hp: new Float32Array([15, 25]),
    kind: new Float32Array([2, 1]),
  };
  assert.strictEqual(updatePointGeometry(geometry, changed, false), geometry);
  assert.strictEqual(geometry.getAttribute('position'), position);
  assert.equal(position.version, 0);
  assert.strictEqual(geometry.getAttribute('hp'), hp);
  assert.deepEqual(hp.array, changed.hp);
  assert.strictEqual(geometry.boundingSphere, sphere);
  assert.equal(position.getX(0), 1);
  updatePointGeometry(geometry, changed, true);
  assert.equal(position.getX(0), 100);
  assert.equal(position.version, 1);
  assert.ok(geometry.boundingSphere?.containsPoint(new THREE.Vector3(100, 200, 300)));
  assert.notStrictEqual(
    updatePointGeometry(geometry, {
      positions: new Float32Array(),
      hp: new Float32Array(),
      kind: new Float32Array(),
    }),
    geometry,
  );
});

test('walking physical pixels stay within budget at 4K/HiDPI without changing orbit quality', () => {
  for (const cs2 of [false, true])
    for (const software of [false, true]) {
      const ratio = viewPixelRatio(3840, 2160, 2, cs2, software, true);
      assert.ok(3840 * 2160 * ratio * ratio <= 1_500_001);
      assert.ok(ratio <= (cs2 ? (software ? 0.75 : 1) : 2));
    }
  assert.equal(viewPixelRatio(1280, 800, 2, false, false, false), 2);
  assert.equal(viewPixelRatio(1280, 800, 2, true, true, false), 0.75);
});

test('display lighting follows Inferno sunlight in Z-up space without extra shadow passes', () => {
  const [sky, sun] = cs2Lighting();
  assert.ok(sky instanceof THREE.HemisphereLight);
  assert.deepEqual(sky.position.toArray(), [0, 0, 1]);
  assert.notDeepEqual(sky.color, sky.groundColor);
  assert.ok(sun instanceof THREE.DirectionalLight);
  assert.equal(sun.castShadow, false);
  const direction = sun.position.clone().normalize();
  const pitch = (63 * Math.PI) / 180;
  const yaw = (218 * Math.PI) / 180;
  assert.ok(Math.abs(direction.x + Math.cos(pitch) * Math.cos(yaw)) < 1e-7);
  assert.ok(Math.abs(direction.y + Math.cos(pitch) * Math.sin(yaw)) < 1e-7);
  assert.ok(Math.abs(direction.z - Math.sin(pitch)) < 1e-7);
  assert.equal(sun.color.getHex(), 0xfff7eb);
});

test('mode-switch disposal frees nested/shared lightmap and hidden albedo once', () => {
  const group = new THREE.Group(),
    child = new THREE.Group();
  group.add(child);
  const lightMap = new THREE.Texture(),
    albedo = new THREE.Texture();
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial({ lightMap });
  material.userData.texture = albedo;
  child.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const counts = new Map<THREE.EventDispatcher, number>();
  for (const object of [lightMap, albedo, geometry, material]) {
    counts.set(object, 0);
    object.addEventListener('dispose', () => counts.set(object, (counts.get(object) ?? 0) + 1));
  }
  setMapShadows(group, false);
  assert.equal(material.lightMap, null);
  setMapShadows(group, true);
  assert.strictEqual(material.lightMap, lightMap);
  setMapShadows(group, false);
  disposeGroup(group);
  assert.deepEqual([...counts.values()], [1, 1, 1, 1]);
  assert.equal(group.children.length, 0);
});
