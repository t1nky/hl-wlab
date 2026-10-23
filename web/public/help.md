# Wallbang Lab

[Source & licenses](source.html) · [Back to the app](./)

For CS1.6, open **Maps**, choose **Half-Life folder**, select Half-Life (containing cstrike and valve),
then choose an imported map and **Load map**. Selecting cstrike alone also works,
but shared base-game resources may be missing. The app finds maps, a player
model, materials, required WAD textures and skyboxes and copies them into local
browser file storage (OPFS). Nothing is uploaded or written to your game folder.
Import progress and cancellation are available. Re-import to refresh changed
files; identical files are reused. Files inside PAK archives are not extracted.

CS1.6 uses one folder-upload flow (`webkitdirectory`). OPFS storage
requires HTTPS or localhost. Safari is secondary.
Individual-file import is still available under **Import / export files**.
For the local CS2 tool, open **Maps**, select a map and **Load map**. Your installed
CS2 maps and downloaded Workshop maps are discovered automatically. Use **Choose CS2 folder**
if the installation is elsewhere; select **Counter-Strike Global Offensive**, containing `game/csgo`.
The first load prepares textures, physics and player poses locally, with progress and cancellation.
Later loads reuse the saved package. The selected map is remembered. CS2 preparation requires
the local development server, Bun and the .NET 10 SDK; it is not available on GitHub Pages.
CS2 packages live in the ignored `.local/cs2/<map>` folders, rather than OPFS.
They can be transferred privately to another computer running this checkout, without Steam there.
The game directory is read only and no assets are uploaded. Maps using unsupported bake formats
use fallback lighting; live doors, breakables and movable props remain outside the static model.
Choose Walk, click the map, move with WASD, look in the desired direction and press E to place
the target. Set stance and armor in **Target**; choose the weapon and spacing in **Scan**.
The scan button stays at the bottom of the card, with result filters stacked below it.
Click a result to inspect damage or stand at that position.

## Controls

- Fly/Walk: click empty map space to begin; WASD moves. Space jumps, C holds crouch,
  V toggles crouch. In Fly, Space/C moves up/down and Shift moves faster.
- E places the target at your exact body position and view angle in Walk.
  Escape releases the mouse and pauses navigation. Editing controls, switching
  tabs or leaving the window also pauses movement.
- Switching Fly → Walk deploys onto the first walkable surface below your camera,
  preserving X/Y and facing. Player collision includes boxes, narrow props and upper floors.
  It tries crouching if standing will not fit; a blocked or empty position leaves you in Fly.
  Choose **View → Resume Walk** to return to your previous walking position instead,
  without deploying. **Walk from here** moves to the selected firing position.
- Click a result in either mode to inspect it and pause movement. While the pointer
  is locked, click a result under the crosshair. Click empty space to resume navigation.
- With the map focused: F frames the target, Home fits the full map, Enter
  inspects a result, arrows browse visible results, Escape clears the selection.
- Ctrl/⌘+Enter runs a scan. Changing target, weapon, spacing or radius clears
  outdated results and stops the affected scan. Nothing scans automatically.
  Armor updates the selected shot without retracing; display controls filter results.
- Cutaway starts off. Its far-right endpoint is Off; lowering it hides ceilings
  and upper floors. Target framing preserves it; Fit map resets it.

View → Keyboard & mouse lists these bindings. Empty filters
offer Reset filters. Enter in a bookmark name saves it.

**View → Performance** toggles a bottom-right overlay and saves the preference.
Rendering is capped at **60 FPS** in both games. FPS counts rendered frames;
**Idle** means the static map is sleeping. CPU and GPU
are frame times in milliseconds, not system utilization. Idle views retain the last
frame timings. GPU time requires the browser's WebGL timer extension. RAM is the
JavaScript heap only where exposed; VRAM is an estimate of loaded scene geometry
and textures, excluding framebuffers and driver overhead. Unavailable readings show —.
The overlay polls twice per second without adding a continuous render loop.

Selectors support arrow keys, Enter to choose and Escape to cancel. Long lists
include search; typing also opens a selector. Tab accepts the highlighted option
and moves to the next control.

In **Target**, **Aim point** selects Head (default), Chest or Pelvis. **Best damage**
chooses the strongest of those three shots at each position. The marker and trace
follow the chosen shot. Switching aim points uses existing scan results without
retracing; bookmarks and exported scenes retain the choice.

**Below min** shows hits below the damage slider's threshold, including direct
hits and wallbangs. It has its own color and toggle; shooter stance still applies.

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
