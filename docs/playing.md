# Playing

This guide is for players. Someone in your group, the *lobby master*, runs the server and gives you
a link. If that's you, read [Hosting](hosting.md) first.

## What you need

- **A link** from your lobby master, such as `https://heroes.example.com/?key=4f2a9c...`.
  The part after `?key=` lets you download the game files from them.
- **The game.** You need to own Heroes of Might and Magic III Complete. If your lobby master offers
  the game files, the link downloads them for you; otherwise you choose your own installation folder.
- **A current browser**: Chrome, Edge, Firefox, or Safari 17 or newer. Phones and tablets work too.
- **About 400 MB of free disk space** for the game files in the browser's storage.

## 1. Open the link

Open the link in the browser you want to play in. The key from the link is remembered, so later you
can simply open the address without it, or use a bookmark.

> [!TIP]
> Always use the same browser and the same address. The game files and your saved games are stored
> inside the browser, separately for every address: a different browser, a private window or a
> new address starts from scratch.

## 2. Get the game files (first visit only)

**If the link downloads the game**, you'll see *Downloading the game* with a progress bar. It's
about 360 MB, once. You can close the page and come back: the download continues where it stopped.

**Otherwise**, choose your Heroes III folder:

1. Click **Choose game folder** (or drag the folder onto the box).
2. Select the folder where Heroes III Complete is installed, the one that contains `Data`, `Maps`
   and `Mp3`. For the GOG version on Windows that's `C:\GOG Games\HoMM 3 Complete`.
3. Confirm the browser's question about uploading files. Nothing is uploaded anywhere: the files are
   copied into the browser's private storage on your computer.

Notes:

- The GOG Complete edition is tested. Other editions with the Shadow of Death data should work.
  Horn of the Abyss content is not supported.
- On a Mac or Linux PC without a Windows installation, you can unpack the GOG installer with
  [innoextract](https://constexpr.org/innoextract/) (`brew install innoextract` or
  `sudo apt install innoextract`, then `innoextract setup_heroes_of_might_and_magic_3_complete_*.exe`)
  and choose the `app` folder it creates.
- **Phones and tablets can't choose folders.** Ask your lobby master to offer the game files, and
  open their link.
- *Manage game files* on the launcher lets you replace or remove the files later. Saved games are kept.

## 3. Play

Press **Play**. The first start takes a few seconds; then you're in the familiar main menu.
Single scenarios, campaigns, random maps and hot-seat work like in the original game.

**Controls**

| | Mouse and keyboard | Touch screen |
| --- | --- | --- |
| Select, move, press buttons | Left click | Tap |
| Information (creature stats, map objects) | Hold the right mouse button | Press and hold |
| Scroll the adventure map | Move the mouse to the screen edge, or click the minimap | Drag |
| Fullscreen | The button in the top right corner, F11, or *Fullscreen* in the game options | |

The keyboard shortcuts of the original game work too, for example `E` to end the turn, the arrow
keys to move the selected hero, and `D` to defend in battle. The game takes all keys except browser shortcuts such as reload or closing the tab.

**Saving**: save and load as usual. Saved games stay in this browser for this address; clearing the
browser's site data deletes them. The launcher asks the browser to keep the storage, which most
browsers then do.

## 4. Play online with friends

Everyone opens the **same address** from the same lobby master. Then:

1. *New Game → Multiplayer → Online Lobby* (the button with the globe).
2. The first time, choose **New Account**, type a name (4 to 20 characters) and confirm. The
   account belongs to this browser: next time you are logged in with one click.
3. **The host** (one of the players) clicks **Create New Room**, and chooses:
   - how many players can join (2 to 8, including the host),
   - **Public** (everyone in the lobby sees the room) or **Private** (only players the host invites),
   - **New Game** or **Load Game** (to continue a saved multiplayer game).
4. **The others** click the room in the *Game Rooms* list and join it. For a private room, the host
   invites them first.
5. The host picks the scenario or random map and the players' colors and towns, like in a single
   scenario, and starts the game.

The match runs inside the **host's** browser tab. The host should keep that tab open, and preferably
in view, until the game ends; if it closes, the game stops for everyone. Only the host can save a
multiplayer game: to continue later, the host creates a room with **Load Game** and the others join.

Hot-seat (several players on one device): *New Game → Multiplayer → Hot Seat* (the top button).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| *This browser can't run the game* | Update your browser. The address must start with `https://`; ask your lobby master if it doesn't. |
| *The game is already open* | The game can only run in one tab at a time. Close the other tab or window first. |
| *Not enough memory* | Close other tabs, then use **Open in a new tab**. This mostly happens on phones after reloading the page several times. On phones, prefer small and medium maps. |
| The download stops | It retries by itself a few times. **Try again** continues where it stopped. |
| *The key in your invite link is not valid* | The lobby master changed the key. Ask for a new link. |
| No sound | Click or tap into the game once: browsers only play sound after you interact with the page. |
| *Unable to connect* in the Online Lobby | The lobby master's server may be down. Try again later or ask them. |
| My saves are gone | You probably opened a different address or browser, or the browser's data was cleared. |

When asking for help, add `?debug` to the address (for example
`https://heroes.example.com/?debug`): the game then writes detailed messages to the browser's
developer console. `?audio=off` starts the game without sound.
