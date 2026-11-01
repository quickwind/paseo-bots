# Upgrading Bot Crew without losing the bots

Checked on a test instance (Paseo 0.11.2) from `build 39` to `build 40`: the daemon did not restart,
the bot list, the chats and the bots' folders were all still there, and the plugin process was replaced.

## Do not run `paseo plugin remove`

`plugin remove` deletes `<PASEO_HOME>/plugin-settings/bot-crew/`, and the bot list (`bots.json`) lives there. After a
remove and a fresh install the Bots screen says "No bots yet", and the bots' folders under `plugin-data/bot-crew/` stay
behind with nobody using them. (Host code: `packages/server/src/server/plugins/index.ts`, `removePlugin`.)
`paseo plugin update` does not apply to a plugin installed from a folder (it says to run `paseo plugin install <folder>`).

## Steps

1. Back up the bot list: copy `<PASEO_HOME>/plugin-settings/bot-crew/bots.json` somewhere safe (`PASEO_HOME` is `~/.paseo`
   by default). The bot menu's "Export" is not a full backup: it copies a bot's definition only, not its host, folder,
   tool grants, secrets or chats.
2. Run `paseo plugin ls` and note the install directory of `bot-crew` (the DIRECTORY column).
3. Unzip the new `bot-crew-<version>.zip` into an empty folder. It holds one folder, `bot-crew-<version>/`.
4. Copy all of its files over the install directory: `cp -R <unzipped>/bot-crew-<version>/. <install directory>/`
5. Run `paseo plugin reload bot-crew`. No daemon restart is needed.
6. Run `paseo plugin ls` and check the state is `running`. Refresh the browser page: the version at the foot of the Bots
   screen shows the new version, and the bots and their chats are still there.

Files that the old version had and the new one lacks are not removed by `cp -R`. To clear them too, use
`rsync -a --delete <unzipped>/bot-crew-<version>/ <install directory>/` (not tried).

The install directory keeps its old name (for example `build 39`) although it now holds the new version; the path in
`config.json` is unchanged.

## Not checked

- `rsync --delete`; a new version that removes files; a reload while a chat is answering.
- Whether an already open browser tab needs a refresh to get the new client code (every check opened a new page).
- Restoring from a saved `bots.json`.
