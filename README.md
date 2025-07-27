# DLV For Asp - Obsidian Plugin
## Dlv For ASP Resolver

---

### Installation
### From Release
1. Download the latest release, the name is 'dlv-for-obsidian.zip'.
2. Extract the zip, manteining the folder 'dlv-for-obsidian' and all the files inside, ininside where your vault is.  Exampe: *'myVault/.obsidian/plugins/
3. 3. Start/Restart Obsidian.
4. Go in the *Obsidian Settings* -> *Community Plugins*, and activate **DLV in Obsidian**.

----

#### Manually

**Prerequisites:** Having Node Package Manager installed.

1. Clone the directory `git clone https://github.com/Shadowz-git/dlv-for-asp-resolver.git` inside where your vault is. 
  Exampe: *'myVault/.obsidian/plugins/'*, in this case from terminal: `cd myVault/.obsidian/plugins` -> `git clone https://github.com/Shadowz-git/dlv-for-asp-resolver.git`.
2. From the git clone, `cd dlv-for-asp-resolver` -> `npm install`.
3. Start/Restart Obsidian.
4. Go in the *Obsidian Settings* -> *Community Plugins*, and activate **DLV in Obsidian**.

---

### Features
- Execute ASP inside Obsidian, using the selected DLV in the plugin settings.
- Button to create ASP (or selected languages) scripts. You can execute single scripts, and the result will be added in the end of the script in the form of a comment.
- Execute code blocks (with selected languages).

---

### Settings
- #### Installation Type
  - Default: Relative to Plugin, the reason is, there is already a 'executables' folder with 4 differents version of DLV (macOS arm64, macOS 64, linux and windows).

  - Relative to Plugin: Search for the dlv executables from the *.obsidian/plugin/* folder.
  - Absolute Path: You need to add the path to the executable.

- #### Plugin Executables
  Gives a list of the executables that has been finded from the *Installation Type* path, and select the executable that you want to use if there is more than 1.

- #### Execution Timeout
  - Default: `0`

  - Custom: put a custom timeout time (in milliseconds) for a script to run. *Example:* `10000`, is a 10 seconds timeout.

- #### Supported File Extensions
  Say to obisidian that codeblocs and file having that File Extension are gonna be treated by this plugin.

  - Default: `asp, dlv`

  - Custom: ext1, ext2. (The names of the file extension are lowercase and without the dot (.), separated by a comma (,) ). *Example:* `py, css, html`

- #### Show All Models
  - Default: `false`

  - If true: Show all the Answer Sets that he finded.

- #### Hide Facts
  - Default: (i dont remember xD)

  - If true: Does not show the facts.

- #### Error Handling
  - Default: (I dont remeber this too)

  - If true: Show if there are been errors (even warnings).

## Contacts
For those who knows me, Whatsapp or Discord. For those who dont, ripperotty
