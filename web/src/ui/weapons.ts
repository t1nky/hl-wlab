import { DEFAULT_WEAPON, getWeapon, isWeaponID, WEAPONS } from '../engine/weapons.ts';
import { $ } from './dom.ts';

export function selectedWeapon() {
  return getWeapon(selectedWeaponID());
}
export function selectedWeaponID() {
  const id = $('weapon').value;
  if (!isWeaponID(id)) throw Error('Choose a weapon preset');
  return id;
}

export function selectWeapon(id: string) {
  const weapon = getWeapon(id);
  $('weapon').value = id;
  $('radius').value = String(weapon.maxDistance);
  $('radius').max = String(weapon.maxDistance);
  $('weaponNote').hidden = weapon.pellets === 1;
  $('weaponNote').textContent = `Per pellet · ${weapon.pellets} pellets/shot`;
}

export function initializeWeapons() {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const [id, weapon] of Object.entries(WEAPONS)) {
    let group = groups.get(weapon.category);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = weapon.category;
      groups.set(weapon.category, group);
    }
    const option = document.createElement('option');
    option.value = id;
    option.textContent = weapon.label;
    group.append(option);
  }
  $('weapon').replaceChildren(...groups.values());
  selectWeapon(DEFAULT_WEAPON);
}
