# Wallbang Lab

[Source & licenses](source.html) · [Back to the app](./)

Choose **Half-Life folder**, select Half-Life (containing cstrike and valve),
then choose an imported map and **Load map**. Selecting cstrike alone also works,
but shared base-game resources may be missing. The app finds maps, a player
model, materials, required WAD textures and skyboxes and copies them into local
browser file storage (OPFS). Nothing is uploaded or written to your game folder.
Import progress and cancellation are available. Re-import to refresh changed
files; identical files are reused. Files inside PAK archives are not extracted.

All browsers use one folder-upload flow (`webkitdirectory`). OPFS storage
requires HTTPS or localhost. Safari is secondary.
Individual-file import is still available under **Import / export files**.
Choose Walk, click the map, move with WASD, look in the desired direction and press E to place
the target. Set its stance and armor, choose a weapon, then Scan. Click a result to inspect
damage or stand at that position.

## Controls

- Map: drag to orbit, middle/right-drag or Shift-drag
  to pan, scroll to zoom toward the cursor. Modified clicks do not move the target.
- Walk/Fly: click the map to begin; WASD moves. Space jumps, Ctrl holds crouch,
  C toggles crouch. In Fly, Space/Ctrl moves up/down and Shift moves faster.
- E places the target at your exact body position and view angle in Walk.
  Escape releases the mouse and pauses navigation. Editing controls, switching
  tabs or leaving the window also pauses movement.
- Walk resumes the previous walking position. Only Walk from here
  moves to a selected firing position.
- With the map focused: F frames the target, Home fits the full map, Enter
  inspects a result, arrows browse visible results, Escape clears the selection.
- Ctrl/⌘+Enter runs a scan. Changing target, weapon, spacing or radius clears
  outdated results and stops the affected scan. Nothing scans automatically.
  Armor updates the selected shot without retracing; display controls filter results.
- Cutaway starts off. Its far-right endpoint is Off; lowering it hides ceilings
  and upper floors. Target framing preserves it; Fit map resets it.

View → Keyboard & mouse lists these bindings. Empty filters
offer Reset filters. Enter in a bookmark name saves it.

In **Bookmarks**, enter a name and choose **Save position**. **Load** restores
the saved map, exact view/player position, target pose and armor, selected firing
point, weapon and scan/display settings. Rename or delete entries as needed.
Map files are shared between bookmarks and stay on this device. Loading does
not start a scan. A restored walking position stays still until you move.

Halve spacing (24, 12, 6, 3) to retain aligned cached vectors. Radius is the
horizontal search boundary. Changing weapons sets it to that preset's maximum
projectile range. AWP is the default, at 8192 units; you can reduce the radius.
Display filters and armor changes do not retrace shots.

This experimental static-scene simulation uses imported BSP hulls and actual
model hitboxes. It considers three aim anchors, one animation frame and a
zero-spread projectile. Damage is per bullet, or per pellet for shotguns;
pellet spread and combined shell/burst damage are not simulated. Movement is
approximate. Game parity is not certified.
Folder imports resolve external textures from referenced WAD3 archives and load
matching skyboxes automatically. Missing resources appear under **Import notices**.
Skyboxes can also be imported as six matching TGAs.

The application shell works offline after its first complete production load;
folder resources are stored in OPFS; bookmark/library metadata, manual imports
and scan caches use IndexedDB. Keep
using the same URL and port to access that cache. Browser storage can be cleared
or evicted; retain your original asset files and exported scenes.

Independent community project, unaffiliated with Valve. Game assets remain the
property of their owners. See the source repository's NOTICE.md,
and the bundled licenses/ directory, for application attribution.
