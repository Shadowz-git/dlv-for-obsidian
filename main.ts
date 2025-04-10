import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	MarkdownPostProcessorContext,
} from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";


const execAsync = promisify(exec);

interface MyPluginSettings {
	dlvPath: string;
	customExtensions: string; // es. "asp, asp.net, prolog"
	showAllModels: boolean;
	hideFacts: boolean;
	cacheResults: boolean;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	dlvPath: "",
	customExtensions: "asp", // può essere una lista separata da virgola
	showAllModels: false,
	hideFacts: false,
	cacheResults: true,
};

export default class DlvPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new DlvSettingTab(this.app, this));

		console.log("DLV Plugin caricato");

		// REGISTRA il post-processor per la modalità Preview:
		this.registerMarkdownPostProcessor(
			(element: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
				// Cerca tutti i blocchi di codice (pre > code)
				element.querySelectorAll("pre code").forEach((codeEl) => {
					const langClass = Array.from(codeEl.classList).find((cls) =>
						cls.startsWith("language-")
					);
					if (!langClass) return;
					const lang = langClass.replace("language-", "").toLowerCase();
					const exts = this.settings.customExtensions
						.split(",")
						.map((x) => x.trim().toLowerCase());
					// Controlla se il linguaggio è tra quelli indicati (match esatto o inizia con "ext.")
					if (!exts.some((e) => lang === e || lang.startsWith(e + ".")))
						return;

					// Costruisci il wrapper
					const wrapper = document.createElement("div");
					wrapper.className = "dlv-wrapper";
					wrapper.style.border = "1px solid var(--background-modifier-border)";
					wrapper.style.margin = "10px 0";
					wrapper.style.padding = "5px";

					// Header (con linguaggio e tasto Run)
					const header = document.createElement("div");
					header.className = "dlv-header";
					header.style.display = "flex";
					header.style.alignItems = "center";
					header.style.justifyContent = "space-between";
					header.style.marginBottom = "5px";

					const langLabel = document.createElement("span");
					langLabel.textContent = lang.toUpperCase();
					langLabel.style.fontWeight = "bold";
					header.appendChild(langLabel);

					const runBtn = document.createElement("button");
					runBtn.textContent = "Run with DLV";
					runBtn.className = "dlv-run-button";
					header.appendChild(runBtn);

					// Crea l'output container (con divider)
					const divider = document.createElement("hr");
					divider.className = "dlv-divider";

					const outputWrapper = document.createElement("div");
					outputWrapper.className = "dlv-output-wrapper";
					outputWrapper.style.position = "relative";
					outputWrapper.style.marginTop = "5px";

					const outputPre = document.createElement("pre");
					outputPre.className = "dlv-output";
					outputPre.style.outline = "1px solid var(--interactive-accent)";
					outputPre.style.padding = "5px";
					outputPre.style.whiteSpace = "pre-wrap";
					outputPre.style.minHeight = "50px";
					outputWrapper.appendChild(outputPre);

					const copyBtn = document.createElement("button");
					copyBtn.className = "dlv-copy-output-btn";
					copyBtn.textContent = "Copy Output";
					copyBtn.style.position = "absolute";
					copyBtn.style.top = "5px";
					copyBtn.style.right = "5px";
					outputWrapper.appendChild(copyBtn);

					// Inserisci header, il blocco di codice e output nel wrapper
					wrapper.appendChild(header);
					// Clona l'elemento pre contenente il codice
					const originalPre = codeEl.parentElement;
					if (!originalPre) return;
					wrapper.appendChild(originalPre.cloneNode(true));
					wrapper.appendChild(divider);
					wrapper.appendChild(outputWrapper);

					// Sostituisci il blocco originale con il wrapper
					originalPre.parentElement?.replaceChild(wrapper, originalPre);

					// Event listener per il tasto Run
					runBtn.addEventListener("click", async () => {
						runBtn.disabled = true;
						new Notice("Running DLV on code block...", 1500);
						const codeContent = codeEl.textContent;
						if (!codeContent) {
							new Notice("Nessun codice da eseguire.");
							runBtn.disabled = false;
							return;
						}
						try {
							const output = await this.runDlvFromContent(lang, codeContent);
							outputPre.innerText = output;
						} catch (err: any) {
							console.error("DLV Error:", err);
							new Notice(`DLV Error: ${err.message}`, 5000);
						} finally {
							runBtn.disabled = false;
						}
					});

					// Event listener per il tasto Copy Output
					copyBtn.addEventListener("click", async () => {
						try {
							await navigator.clipboard.writeText(outputPre.innerText);
							new Notice("Output copiato!");
						} catch (err: any) {
							new Notice(`Errore copia output: ${err.message}`, 5000);
						}
					});
				});
			}
		);

		// REGISTRA un Editor extension per la modalità Edit.
		// La logica è simile: cerchiamo il pattern dei code fence e aggiungiamo widget (header e footer)
		// NOTA: La modifica in modalità Edit tramite CodeMirror è meno “invasiva” e può essere meno affidabile,
		// ma di seguito un esempio semplificato.
		this.registerEditorExtension(this.getEditorDecoration());
	}

	/**
	 * Funzione che esegue DLV sul contenuto dato e ritorna la stringa di output.
	 * In questa implementazione il contenuto viene scritto in un file temporaneo.
	 */
	async runDlvFromContent(lang: string, codeContent: string): Promise<string> {
		if (!this.settings.dlvPath) {
			throw new Error("DLV path not configured!");
		}
		const tmpDir = os.tmpdir();
		const tmpFile = path.join(tmpDir, `dlv-temp-${Date.now()}.${lang}`);
		await fs.writeFile(tmpFile, codeContent, "utf8");

		const argsArr: string[] = [tmpFile];
		if (this.settings.showAllModels) {
			argsArr.push("-n", "0");
		}
		if (this.settings.hideFacts) {
			argsArr.push("--no-facts");
		}
		const cmd = `"${this.settings.dlvPath}" ${argsArr
			.map((arg) => `"${arg}"`)
			.join(" ")}`;

		const execOptions = {
			shell: process.platform === "win32" ? "cmd.exe" : undefined,
		} as { shell?: string };

		const { stdout, stderr } = await execAsync(cmd, execOptions);
		if (stderr) {
			throw new Error(stderr);
		}
		await fs.unlink(tmpFile);
		return stdout;
	}

	/**
	 * Esempio semplificato di editor decoration per la modalità Edit:
	 * Aggiunge un widget header (con tasto Run) sopra ogni code fence che corrisponde alle estensioni.
	 */
	getEditorDecoration() {
		const plugin = this;
		return EditorView.decorations.compute(["doc"], (state: any) => {
			const builder = new RangeSetBuilder<Decoration>();
			const docText = state.doc.toString();
			const regex = /^```(\S+)/gm;
			let match: any;
			while ((match = regex.exec(docText)) !== null) {
				const lang = match[1].toLowerCase();
				const exts = this.settings.customExtensions
					.split(",")
					.map((x: string) => x.trim().toLowerCase());
				if (!exts.some((e: string) => lang === e || lang.startsWith(e + ".")))
					continue;

				const pos = state.doc.lineAt(match.index).from;
				builder.add(
					pos,
					pos,
					Decoration.widget({
						widget: new class extends WidgetType {
							toDOM() {
								const container = document.createElement("div");
								container.style.margin = "10px 0";

								// Header con linguaggio e pulsante Run
								const header = document.createElement("div");
								header.style.display = "flex";
								header.style.justifyContent = "space-between";
								header.style.padding = "5px";
								header.style.background = "var(--background-secondary)";
								header.style.border = "1px solid var(--background-modifier-border)";

								const langLabel = document.createElement("span");
								langLabel.textContent = lang.toUpperCase();
								langLabel.style.fontWeight = "bold";
								header.appendChild(langLabel);

								const runBtn = document.createElement("button");
								runBtn.textContent = "Run with DLV";
								runBtn.style.cursor = "pointer";
								header.appendChild(runBtn);

								// Contenitore output
								const outputWrapper = document.createElement("div");
								outputWrapper.style.marginTop = "5px";
								outputWrapper.style.position = "relative";

								const outputPre = document.createElement("pre");
								outputPre.className = "dlv-output-edit";
								outputPre.style.padding = "5px";
								outputPre.style.border = "1px solid var(--interactive-accent)";
								outputPre.style.minHeight = "50px";

								const copyBtn = document.createElement("button");
								copyBtn.textContent = "Copy Output";
								copyBtn.style.position = "absolute";
								copyBtn.style.top = "5px";
								copyBtn.style.right = "5px";
								copyBtn.style.display = "none"; // Nascondi inizialmente

								outputWrapper.appendChild(outputPre);
								outputWrapper.appendChild(copyBtn);

								// Assembla tutto
								container.appendChild(header);
								container.appendChild(outputWrapper);

								// Logica esecuzione
								runBtn.onclick = async () => {
									const codeRegex = new RegExp(`\`\`\`\\s*${lang}\\s*([\\s\\S]*?)\\\`\`\``, "m");
									const codeMatch = docText.match(codeRegex);
									if (!codeMatch) return;

									try {
										runBtn.disabled = true;
										const output = await plugin.runDlvFromContent(lang, codeMatch[1].trim());
										outputPre.textContent = output;
										copyBtn.style.display = "block";
									} catch (err) {
										outputPre.textContent = `Error: ${err.message}`;
									} finally {
										runBtn.disabled = false;
									}
								};

								// Copia output
								copyBtn.onclick = async () => {
									await navigator.clipboard.writeText(outputPre.textContent || "");
									new Notice("Output copiato!");
								};

								return container;
							}
						}(),
						side: 1, // Posiziona dopo il codeblock
					})
				);
			}
			return builder.finish();
		});
	}


	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* ============================================
   SECTION: Plugin Settings Tab
============================================ */
class DlvSettingTab extends PluginSettingTab {
	plugin: DlvPlugin;
	constructor(app: App, plugin: DlvPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "DLV Plugin Settings" });

		new Setting(containerEl)
			.setName("DLV Executable Path")
			.setDesc("Percorso assoluto a DLV.exe")
			.addText((text) =>
				text
					.setPlaceholder("C:\\path\\to\\dlv.exe")
					.setValue(this.plugin.settings.dlvPath)
					.onChange(async (value) => {
						this.plugin.settings.dlvPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("File Extensions (for code blocks)")
			.setDesc("Elenco separato da virgola dei linguaggi da riconoscere (es. asp, asp.net, prolog)")
			.addText((text) =>
				text
					.setPlaceholder("asp, asp.net, prolog")
					.setValue(this.plugin.settings.customExtensions)
					.onChange(async (value) => {
						this.plugin.settings.customExtensions = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show All Models")
			.setDesc("Abilita il flag '-n 0'")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showAllModels)
					.onChange(async (value) => {
						this.plugin.settings.showAllModels = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hide Facts")
			.setDesc("Abilita il flag '--no-facts'")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideFacts)
					.onChange(async (value) => {
						this.plugin.settings.hideFacts = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Cache Results")
			.setDesc("Abilita la cache dell'output")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.cacheResults)
					.onChange(async (value) => {
						this.plugin.settings.cacheResults = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
