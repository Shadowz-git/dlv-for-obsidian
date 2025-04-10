import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	MarkdownPostProcessorContext,
	TFile

} from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";
import { RangeSetBuilder } from "@codemirror/state";
import {Decoration, EditorView, WidgetType} from "@codemirror/view";
import * as path from "path";
import { promises as fs } from "fs";
import * as os from "os";

const execAsync = promisify(exec);

interface DlvPluginSettings {
	dlvPath: string;
	customExtensions: string;
	showErrors: boolean;
	showAllModels: boolean;
	hideFacts: boolean;
	cacheResults: boolean;
}

const DEFAULT_SETTINGS: DlvPluginSettings = {
	dlvPath: "",
	customExtensions: "asp",
	showErrors: false,
	showAllModels: false,
	hideFacts: false,
	cacheResults: true,
};

class CodeBlockWidget extends WidgetType {
	constructor(
		private plugin: DlvPlugin,
		private lang: string,
		private start: number,
		private end: number,
		private docText: string
	) { super(); }

	toDOM() {
		const { header, outputPre, copyBtn } = this.plugin.createCodeBlockUI(this.lang);
		const runBtn = header.querySelector('.run-btn') as HTMLButtonElement;
		const saveBtn = header.querySelector('.save-btn') as HTMLButtonElement;

		runBtn.onclick = async () => {
			runBtn.disabled = true;
			try {
				const codeContent = this.docText.slice(this.start, this.end).trim();
				const result = await this.plugin.executeDlv(codeContent, this.lang);
				this.plugin.updateOutputUI(outputPre, copyBtn, result);
			} finally {
				runBtn.disabled = false;
			}
		};

		saveBtn.onclick = async () => {
			saveBtn.disabled = true;
			try {
				const codeContent = this.docText.slice(this.start, this.end).trim();
				const result = await this.plugin.executeDlv(codeContent, this.lang);
				await this.plugin.saveExecutionResult(result);
			} finally {
				saveBtn.disabled = false;
			}
		};

		copyBtn.onclick = () => this.plugin.copyToClipboard(outputPre.textContent || "");

		const container = document.createElement("div");
		container.className = "dlv-codeblock";
		container.append(header, outputPre);
		return container;
	}

	eq(other: CodeBlockWidget) {
		return this.start === other.start && this.end === other.end && this.lang === other.lang;
	}
}

export default class DlvPlugin extends Plugin {
	settings: DlvPluginSettings;
	private stylesEl: HTMLStyleElement;

	async onload() {
		await this.loadSettings();
		this.addStyle();
		this.registerEditorExtension(this.getEditorDecoration());
		this.registerMarkdownPostProcessor(this.markdownPostProcessor.bind(this));
		this.addSettingTab(new DlvSettingTab(this.app, this));
		this.registerFileHeaderButtons();
	}

	private registerFileHeaderButtons() {
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (file instanceof TFile && this.isSupportedExtension(file.extension)) {
				this.addRunButtonToHeader(file);
			}
		}));
	}

	private addStyle() {
		this.stylesEl = document.createElement('style');
		this.stylesEl.textContent = `
            .dlv-codeblock {
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                margin: 1rem 0;
                padding: 0.5rem;
            }
            .dlv-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0.5rem;
                margin-top: 0.5rem;
            }
            .dlv-output {
                white-space: pre-wrap;
                word-break: break-word;
                padding: 0.5rem;
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                position: relative;
            }
            .dlv-error {
            	color: #ff5555;
            	margin-top: 0.5rem;
        	}
            .dlv-buttons {
                display: flex;
                gap: 0.5rem;
            }
			.dlv-run-container {
				gap: 4px;
				margin-right: 12px;
			}
			.dlv-run-button {
				color: var(--text-normal) !important;
				transition: background-color 0.15s ease;
			}
			.dlv-run-button:hover {
				background-color: var(--background-modifier-hover) !important;
			}
			.dlv-run-button svg {
				flex-shrink: 0;
			}
			.dlv-button-text {
				font-size: 0.85em;
				position: relative;
				bottom: 0.076rem;
			}
			@media (max-width: 400px) {
				.dlv-button-text {
					display: none;
				}
			}
			.dlv-tooltip {
				color: var(--text-muted);
				font-size: 0.85em;
			}
        `;
		document.head.appendChild(this.stylesEl);
	}

	createCodeBlockUI(lang: string) {
		const header = document.createElement("div");
		header.className = "dlv-header";

		const langLabel = document.createElement("span");
		langLabel.textContent = lang.toUpperCase();

		const buttons = document.createElement("div");
		buttons.className = "dlv-buttons";

		const runBtn = this.createButton("▶ Run", "run-btn");
		const saveBtn = this.createButton("💾 Save", "save-btn");
		const copyBtn = this.createButton("📋 Copy", "copy-btn");

		buttons.append(runBtn, saveBtn);
		header.append(langLabel, buttons);

		const outputPre = document.createElement("pre");
		outputPre.className = "dlv-output";
		outputPre.style.display = "none";

		return { header, outputPre, copyBtn };
	}

	private createButton(text: string, className: string) {
		const btn = document.createElement("button");
		btn.className = className;
		btn.textContent = text;
		return btn;
	}

	async executeDlv(content: string, lang: string) {
		if (!this.settings.dlvPath) {
			throw new Error("Percorso di DLV non configurato!");
		}

		const tmpDir = os.tmpdir();
		const tmpFile = path.join(tmpDir, `dlv-temp-${Date.now()}.${lang}`);
		await fs.writeFile(tmpFile, content, "utf8");

		const argsArr = [tmpFile];

		if (this.settings.showAllModels) {
			argsArr.push("-n", "0");
		}
		if (this.settings.hideFacts) {
			argsArr.push("--no-facts");
		}

		try {
			const { stdout, stderr } = await execAsync(
				`"${this.settings.dlvPath}" ${argsArr.map(arg => `"${arg}"`).join(" ")}`,
				{ shell: process.platform === "win32" ? "cmd.exe" : undefined }
			);

			// Pulizia degli output
			const cleanedStdout = this.cleanOutput(stdout);
			const cleanedStderr = this.cleanErrors(stderr);

			return {
				stdout: cleanedStdout,
				stderr: cleanedStderr
			};
		} catch (error) {
			return {
				stdout: "",
				stderr: error instanceof Error ? this.cleanErrors(error.message) : "Errore sconosciuto"
			};
		} finally {
			await fs.unlink(tmpFile).catch(() => {});
		}
	}

	private cleanOutput(output: string) {
		return output
			.replace(/^DLV \d+\.\d+\.\d+\s*\n/, "") // Rimuove la riga della versione
			.replace(/Generic warning: .*\n?/g, "")  // Rimuove i warning generici
			.trim();
	}

	private cleanErrors(errorOutput: string) {
		return errorOutput
			.replace(/Generic warning: .*\n?/g, "")  // Filtra i warning generici
			.trim();
	}

	updateOutputUI(outputEl: HTMLElement, copyBtn: HTMLButtonElement, result: { stdout: string; stderr: string }) {
		outputEl.innerHTML = result.stdout.replace(/\n/g, "<br>");
		outputEl.style.display = "block";

		if (this.settings.showErrors && result.stderr) {
			const errorEl = document.createElement("div");
			errorEl.className = "dlv-error";
			errorEl.innerHTML = result.stderr.replace(/\n/g, "<br>");
			outputEl.appendChild(errorEl);
		}

		copyBtn.style.display = "block";
	}

	async saveExecutionResult(result: { stdout: string; stderr: string }) {
		const timestamp = new Date().toLocaleString();
		let content = `% ${timestamp}\n`;

		if (result.stdout) {
			content += "% AnswerSet\n" +
				result.stdout.split('\n')
					.map(line => `% ${line}`)
					.join('\n');
		}

		if (this.settings.showErrors && result.stderr) {
			content += "\n% Errore\n" +
				result.stderr.split('\n')
					.map(line => `% ${line}`)
					.join('\n');
		}

		const file = this.app.workspace.getActiveFile();
		if (file) {
			await this.app.vault.append(file, `\n\n${content.trim()}`);
			new Notice("Risultato salvato nel file!");
		}
	}
	copyToClipboard(text: string) {
		navigator.clipboard.writeText(text).then(() => new Notice("Copied to clipboard"));
	}

	private addRunButtonToHeader(file: TFile) {
		const titleBar = this.app.workspace.getLeaf().view.containerEl.querySelector(".view-header");
		if (!titleBar) return;

		// Rimuovi eventuali pulsanti precedenti
		const actionsContainer = titleBar.querySelector(".view-actions") || titleBar.querySelector(".titlebar-button-container");
		if (!actionsContainer) return;

		// Rimuovi eventuali pulsanti precedenti
		actionsContainer.querySelectorAll('.dlv-run-button').forEach(btn => btn.remove());

		// Crea il pulsante
		const runBtn = document.createElement("div");
		runBtn.className = "clickable-icon dlv-run-button";
		runBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" 
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        <span class="dlv-button-text">Run</span>
    `;

		// Stile del pulsante
		runBtn.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        margin: 0 2px;
        border-radius: 4px;
        position: relative;
        top: -1px;
    `;

		// Aggiungi hover effect
		runBtn.addEventListener("mouseenter", () => {
			runBtn.style.backgroundColor = "var(--background-modifier-hover)";
		});
		runBtn.addEventListener("mouseleave", () => {
			runBtn.style.backgroundColor = "transparent";
		});

		// Evento click
		runBtn.onclick = async () => {
			try {
				const content = await this.app.vault.read(file);
				const result = await this.executeDlv(content, file.extension);
				await this.saveExecutionResult(result);
			} catch (error) {
				new Notice(`Errore: ${error instanceof Error ? error.message : "Errore sconosciuto"}`);
			}
		};

		actionsContainer.insertBefore(runBtn, actionsContainer.firstChild);
	}

	private markdownPostProcessor(element: HTMLElement, ctx: MarkdownPostProcessorContext) {
		element.querySelectorAll("pre code").forEach((codeEl) => {
			const el = codeEl as HTMLElement; // <-- Aggiungi type assertion
			const lang = this.getCodeBlockLanguage(el);
			if (!lang || !this.isSupportedLanguage(lang)) return;

			const { header, outputPre, copyBtn } = this.createCodeBlockUI(lang);
			const runBtn = header.querySelector('.run-btn') as HTMLButtonElement;
			const saveBtn = header.querySelector('.save-btn') as HTMLButtonElement;

			const wrapper = document.createElement("div");
			wrapper.className = "dlv-codeblock";
			wrapper.append(
				header,
				el.parentElement!.cloneNode(true),
				outputPre
			);

			// Aggiungi gestione eventi
			runBtn.onclick = async () => {
				const result = await this.executeDlv(el.textContent || "", lang);
				this.updateOutputUI(outputPre, copyBtn, result);
			};

			saveBtn.onclick = async () => {
				const result = await this.executeDlv(el.textContent || "", lang);
				await this.saveExecutionResult(result);
			};

			copyBtn.onclick = () => this.copyToClipboard(outputPre.textContent || "");

			el.parentElement?.replaceWith(wrapper);
		});
	}

	private getCodeBlockLanguage(element: HTMLElement) {
		const langClass = Array.from(element.classList).find(c => c.startsWith("language-"));
		return langClass?.replace("language-", "");
	}

	private isSupportedLanguage(lang: string) {
		return this.settings.customExtensions
			.split(",")
			.map(e => e.trim().toLowerCase())
			.some(e => lang.toLowerCase() === e || lang.toLowerCase().startsWith(e + "."));
	}

	private isSupportedExtension(ext: string) {
		return this.isSupportedLanguage(ext);
	}

	getEditorDecoration() {
		return EditorView.decorations.compute(["doc"], state => {
			const builder = new RangeSetBuilder<Decoration>();
			const text = state.doc.toString();
			const regex = /```(\S+)\n([\s\S]*?)```/g;

			let match;
			while ((match = regex.exec(text)) !== null) {
				const lang = match[1].toLowerCase();
				if (this.isSupportedLanguage(lang)) {
					const start = match.index + match[0].indexOf(match[2]);
					const end = start + match[2].length;
					builder.add(end, end, Decoration.widget({
						widget: new CodeBlockWidget(this, lang, start, end, text),
						side: 1
					}));
				}
			}
			return builder.finish();
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		this.stylesEl?.remove();
	}
}

class DlvSettingTab extends PluginSettingTab {
	plugin: DlvPlugin;

	constructor(app: App, plugin: DlvPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'DLV Settings' });

		new Setting(containerEl)
			.setName('DLV Path')
			.setDesc('Path to DLV executable')
			.addText(text => text
				.setValue(this.plugin.settings.dlvPath)
				.onChange(v => {
					this.plugin.settings.dlvPath = v;
					this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Supported Extensions')
			.setDesc('Comma-separated list of file extensions')
			.addText(text => text
				.setValue(this.plugin.settings.customExtensions)
				.onChange(v => {
					this.plugin.settings.customExtensions = v;
					this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Mostra tutti i modelli')
			.setDesc('Abilita il flag -n 0 per visualizzare tutti i modelli')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showAllModels)
				.onChange(v => {
					this.plugin.settings.showAllModels = v;
					this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Nascondi fatti')
			.setDesc('Abilita il flag --no-facts per nascondere i fatti')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideFacts)
				.onChange(v => {
					this.plugin.settings.hideFacts = v;
					this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show Errors')
			.setDesc('Display error messages in output')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showErrors)
				.onChange(v => {
					this.plugin.settings.showErrors = v;
					this.plugin.saveSettings();
				}));
	}
}
