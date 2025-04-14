import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	MarkdownPostProcessorContext,
	TFile, DropdownComponent

} from "obsidian";
import { exec } from "child_process";
import { RangeSetBuilder } from "@codemirror/state";
import {Decoration, EditorView, WidgetType} from "@codemirror/view";
import * as path from "path";
import { promises as fs } from "fs";
import * as os from "os";
import {ChildProcess} from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

interface DlvPluginSettings {
	dlvLocationType: "absolute" | "relative";
	absolutePath: string;
	relativeExecutable: string;
	availableExecutables: string[];
	executionTimeout: number; // in millisecondi
	customExtensions: string;
	showErrors: boolean;
	showAllModels: boolean;
	hideFacts: boolean;
	cacheResults: boolean;
}

const DEFAULT_SETTINGS: DlvPluginSettings = {
	dlvLocationType: "relative",
	absolutePath: "",
	relativeExecutable: "executables/dlv.exe",
	availableExecutables: [],
	executionTimeout: 0,
	customExtensions: "asp",
	showErrors: false,
	showAllModels: false,
	hideFacts: false,
	cacheResults: true,
};

class CodeBlockWidget extends WidgetType {
	private abortController: AbortController | null = null;

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
		const stopBtn = header.querySelector('.stop-btn') as HTMLButtonElement;

		const toggleButtons = (running: boolean) => {
			runBtn.disabled = running;
			saveBtn.disabled = running;
			stopBtn.style.display = running ? 'block' : 'none';
			(runBtn.querySelector('.btn-text') as HTMLElement).textContent = running ? 'Running' : '▶ Run';
			runBtn.classList.toggle('running', running);
		};

		runBtn.onclick = async () => {
			toggleButtons(true);
			this.abortController = new AbortController();

			try {
				const codeContent = this.docText.slice(this.start, this.end).trim();
				const result = await this.plugin.executeDlv(
					codeContent,
					this.lang,
					this.abortController.signal
				);
				this.plugin.updateOutputUI(outputPre, copyBtn, result);
			} finally {
				toggleButtons(false);
				this.abortController = null;
			}
		};

		stopBtn.onclick = () => {
			if (this.abortController) {
				this.abortController.abort();
				toggleButtons(false);
			}
		};

		saveBtn.onclick = async () => {
			toggleButtons(true);
			try {
				const codeContent = this.docText.slice(this.start, this.end).trim();
				const result = await this.plugin.executeDlv(codeContent, this.lang);
				await this.plugin.saveExecutionResult(result);
			} finally {
				toggleButtons(false);
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
	pluginPath: string;
	private activeAbortControllers: Set<AbortController> = new Set();

	async onload() {
		await this.initializePluginPath();
		await this.loadSettings();
		this.addStyle();
		this.registerEditorExtension(this.getEditorDecoration());
		this.registerMarkdownPostProcessor(this.markdownPostProcessor.bind(this));
		this.addSettingTab(new DlvSettingTab(this.app, this));
		this.registerFileHeaderButtons();

		// Aggiungi qui il nuovo codice
		const extensions = this.settings.customExtensions
			.split(',')
			.map(ext => ext.trim().toLowerCase())
			.filter(ext => ext.length > 0);

		if (extensions.length > 0) {
			// @ts-ignore
			this.registerExtensions(extensions, 'markdown');
		}
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
                background: var(--background-secondary);
                padding: 0.5rem;
                border-radius: 4px;
                margin-top: 0.5rem;
                border-left: 3px solid #ff5555;
            }
            .error-icon {
                margin-right: 0.5rem;
                color: #ff5555;
            }
            .error-content {
                display: inline-block;
                vertical-align: middle;
            }
            .error-line {
                margin: 0.25rem 0;
                font-family: var(--font-monospace);
                font-size: 0.9em;
            }
            .dlv-buttons {
                display: flex;
                gap: 0.5rem;
                position: relative;
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
            .btn-text {
                font-size: 0.85em;
                position: relative;
                bottom: 0.076rem;
            }
            .stop-btn {
                color: #ff5555 !important;
                display: none;
            }
            .spinner {
                position: absolute;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%);
                animation: spin 1s linear infinite;
                display: none;
            }
            button.running .spinner {
                display: block;
            }
            button.running .btn-text {
                visibility: hidden;
            }
            @keyframes spin {
                0% { transform: translate(-50%, -50%) rotate(0deg); }
                100% { transform: translate(-50%, -50%) rotate(360deg); }
            }
            @media (max-width: 400px) {
                .btn-text {
                    display: none;
                }
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
		const stopBtn = this.createButton("⏹ Stop", "stop-btn");
		const saveBtn = this.createButton("💾 Save", "save-btn");
		const copyBtn = this.createButton("📋 Copy", "copy-btn");

		buttons.append(runBtn, stopBtn, saveBtn, copyBtn);
		header.append(langLabel, buttons);

		const outputPre = document.createElement("pre");
		outputPre.className = "dlv-output";
		outputPre.style.display = "none";

		return { header, outputPre, copyBtn };
	}

	private createButton(text: string, className: string) {
		const btn = document.createElement("button") as HTMLButtonElement;
		btn.className = className;
		btn.innerHTML = `
            <span class="btn-text">${text}</span>
            <span class="spinner">
                <svg viewBox="0 0 24 24" width="14" height="14">
                    <path fill="currentColor" d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z"/>
                </svg>
            </span>
        `;
		return btn;
	}

	async executeDlv(content: string, lang: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
		const controller = new AbortController();
		this.activeAbortControllers.add(controller);
		if (signal) signal.onabort = () => controller.abort();

		try {
			const dlvPath = this.getDlvPath();
			await fs.access(dlvPath);

			const tmpDir = os.tmpdir();
			await fs.mkdir(tmpDir, { recursive: true });

			const tmpFile = path.join(tmpDir, `dlv-temp-${Date.now()}.${lang}`);
			await fs.writeFile(tmpFile, content, "utf8");

			const args = [tmpFile];
			if (this.settings.showAllModels) args.push("-n", "0");
			if (this.settings.hideFacts) args.push("--no-facts");

			// Aggiungi tipo esplicito per execPromise
			const execPromise: Promise<{ stdout: string; stderr: string }> = execAsync(
				`"${dlvPath}" ${args.map(arg => `"${arg}"`).join(" ")}`,
				{
					shell: process.platform === "win32" ? "cmd.exe" : undefined,
					windowsHide: true,
					encoding: 'utf-8',
					signal: controller.signal
				}
			);

			// Definisci esplicitamente il tipo per result
			let result: { stdout: string; stderr: string };

			if (this.settings.executionTimeout > 0) {
				const timeoutPromise = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Execution timeout")), this.settings.executionTimeout)
				);
				result = await Promise.race([execPromise, timeoutPromise]);
			} else {
				result = await execPromise;
			}

			await fs.unlink(tmpFile).catch(() => {});
			return {
				stdout: this.cleanOutput(result.stdout),
				stderr: this.cleanErrors(result.stderr)
			};
		} catch (error) {
			let errorMessage = "Unknown error";
			if (error instanceof Error) {
				errorMessage = controller.signal.aborted ? "Execution aborted" : error.message;
			}
			return {
				stdout: "",
				stderr: errorMessage
			};
		} finally {
			this.activeAbortControllers.delete(controller);
		}
	}

	private cleanOutput(output: string) {
		return output
			.replace(/^DLV \d+\.\d+\.\d+\s*\n/, "") // Rimuove la riga della versione
			.replace(/Generic warning: .*\n?/g, "")  // Rimuove i warning generici
			.trim();
	}

	private cleanErrors(errorOutput: string): string {
		// Split in linee e filtra
		const lines = errorOutput.split('\n')
			.map(line => {
				// 1. Rimuovi interi percorsi file
				line = line.replace(/([A-Za-z]:\\[^\s]+|\/[^\s]+)/g, '')
					.replace(/(dlv-temp-\d+\.asp)/gi, 'Input');

				// 2. Estrai solo la parte dopo "line X:"
				const errorMatch = line.match(/(line \d+):\s*(.*)/i);
				if (errorMatch) {
					return `${errorMatch[1]}: ${errorMatch[2].replace(/^.*?:\s*/, '')}`;
				}

				// 3. Rimuovi righe non rilevanti
				return line.includes('Command failed:') ||
				line.includes('Aborting due to') ? '' : line;
			})
			.filter(line => line.trim().length > 0);

		// 4. Unisci e formatta
		return lines.join('\n')
			.replace(/(line \d+):/gi, 'Errore:\n$1')
			.replace(/[.:]+$/, '') // Rimuovi punti finali
			.trim();
	}

	private formatErrorMessages(errorString: string) {
		return errorString
			.split('\n')
			.map(line => {
				// Estrai numero linea e messaggio
				const match = line.match(/Linea (\d+):\s*(.*)/i);
				if (match) {
					return `<div class="error-line">
                    <span class="error-line-number">Linea ${match[1]}:</span>
                    <span class="error-message">${match[2]}</span>
                </div>`;
				}
				return line ? `<div class="error-general">${line}</div>` : '';
			})
			.join('');
	}

	updateOutputUI(outputEl: HTMLElement, copyBtn: HTMLButtonElement, result: { stdout: string; stderr: string }) {
		const hasOutput = result.stdout.trim().length > 0;
		const hasErrors = result.stderr.trim().length > 0;

		// Mostra output normale
		outputEl.innerHTML = result.stdout.replace(/\n/g, "<br>");
		outputEl.style.display = "block";

		// Mostra errori se:
		// 1. L'opzione è attiva OPPURE
		// 2. Non c'è output ma ci sono errori
		if ((this.settings.showErrors || !hasOutput) && hasErrors) {
			const errorContent = this.cleanErrors(result.stderr)
				.split('\n')
				.map(line => {
					const parts = line.split(':');
					return `<div class="error-line">
                    <b>${parts[0]}:</b> 
                    ${parts.slice(1).join(':')}
                </div>`;
				})
				.join('');

			const errorEl = document.createElement("div");
			errorEl.className = "dlv-error";
			errorEl.innerHTML = `<pre>${errorContent}</pre>`;
			outputEl.appendChild(errorEl);
		}

		copyBtn.style.display = "block";
	}

	async saveExecutionResult(result: { stdout: string; stderr: string }) {
		const timestamp = new Date().toLocaleString();
		let content = `% ${timestamp}\n`;

		const hasOutput = result.stdout.trim().length > 0;

		// Aggiungi output se presente
		if (hasOutput) {
			content += "% AnswerSet\n" +
				result.stdout.split('\n')
					.map(line => `% ${line}`)
					.join('\n');
		}

		// Aggiungi errori se rilevanti
		if ((this.settings.showErrors || !hasOutput) && result.stderr) {
			content += "\n% Errore\n" +
				result.stderr.split('\n')
					.map(line => `% ${line}`)
					.join('\n');
		}

		if (this.app.workspace.getActiveFile()) {
			await this.app.vault.append(
				this.app.workspace.getActiveFile()!,
				`\n\n${content.trim()}`
			);
		}
	}

	copyToClipboard(text: string) {
		navigator.clipboard.writeText(text).then(() => new Notice("Copied to clipboard"));
	}

	private addRunButtonToHeader(file: TFile) {
		const titleBar = this.app.workspace.getLeaf().view.containerEl.querySelector(".view-header");
		if (!titleBar) return;

		const actionsContainer = titleBar.querySelector(".view-actions") || titleBar.querySelector(".titlebar-button-container");
		if (!actionsContainer) return;

		actionsContainer.querySelectorAll('.dlv-run-button, .dlv-stop-button').forEach(btn => btn.remove());

		const runBtn = document.createElement("div") as HTMLDivElement;
		runBtn.className = "clickable-icon dlv-run-button";
		runBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" 
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span class="dlv-button-text">Run</span>
            <span class="spinner" style="display: none;">
                <svg viewBox="0 0 24 24" width="14" height="14">
                    <path fill="currentColor" d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z"/>
                </svg>
            </span>
        `;

		const stopBtn = document.createElement("div") as HTMLDivElement;
		stopBtn.className = "clickable-icon dlv-stop-button";
		stopBtn.innerHTML = "⏹";
		stopBtn.style.display = "none";

		let abortController: AbortController | null = null;

		const toggleButtons = (running: boolean) => {
			runBtn.style.display = running ? "none" : "flex";
			stopBtn.style.display = running ? "flex" : "none";
			(runBtn.querySelector('.spinner') as HTMLElement).style.display = running ? "block" : "none";
			runBtn.querySelector('.dlv-button-text')!.textContent = running ? "Running" : "Run";
		};

		runBtn.onclick = async () => {
			toggleButtons(true);
			abortController = new AbortController();

			try {
				const content = await this.app.vault.read(file);
				const result = await this.executeDlv(
					content,
					file.extension,
					abortController.signal
				);
				await this.saveExecutionResult(result);
			} finally {
				toggleButtons(false);
				abortController = null;
			}
		};

		stopBtn.onclick = () => {
			if (abortController) {
				abortController.abort();
				toggleButtons(false);
			}
		};

		actionsContainer.prepend(stopBtn);
		actionsContainer.prepend(runBtn);
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

	private async initializePluginPath() {
		try {
			// Ottieni il percorso base corretto della vault
			const vaultPath = (this.app.vault.adapter as any).basePath; // <-- Modifica qui

			// Costruisci il percorso del plugin correttamente
			if (this.manifest.dir != null) {
				this.pluginPath = path.join(
					vaultPath,
					this.manifest.dir
				);
			}

			// Debug
			console.log("Percorso corretto del plugin:", this.pluginPath);

			await fs.mkdir(this.pluginPath, { recursive: true });

		} catch (error) {
			console.error("Errore inizializzazione plugin:", error);
			throw new Error("Configurazione plugin non valida");
		}
	}

	async refreshExecutablesList() {
		if (this.settings.dlvLocationType === "relative") {
			// 5. Percorso eseguibili corretto
			const executablesPath = path.join(this.pluginPath, "executables");
			console.log("Percorso eseguibili:", executablesPath);

			try {
				const files = await fs.readdir(executablesPath);
				this.settings.availableExecutables = files
					.filter(f => f.toLowerCase().includes('dlv'))
					.map(f => path.join('executables', f));

				console.log("Eseguibili trovati:", this.settings.availableExecutables);

			} catch (error) {
				console.error("Errore scansione eseguibili:", error);
			}
		}
	}

	private isValidExecutable(filename: string): boolean {
		// Verifica per Windows
		if (process.platform === 'win32') {
			return filename.toLowerCase().endsWith('.exe');
		}

		// Verifica per Linux/Mac (controllo pattern nome)
		return /^dlv[-_]?(linux|mac|.*)/i.test(filename);
	}

	private getDlvPath() {
		if (this.settings.dlvLocationType === "absolute") {
			return this.settings.absolutePath;
		}

		// 4. Costruzione percorso relativo corretta
		return path.join(
			this.pluginPath,
			this.settings.relativeExecutable
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		await this.refreshExecutablesList();
	}

	async saveSettings() {
		// Validazione rinforzata
		if (this.settings.dlvLocationType === 'relative') {
			const fullPath = path.join(this.pluginPath, this.settings.relativeExecutable);

			if (!await fs.access(fullPath).then(() => true).catch(() => false)) {
				new Notice('⚠️ Eseguibile non trovato nel percorso relativo!');
				return;
			}
		} else {
			if (!await fs.access(this.settings.absolutePath).then(() => true).catch(() => false)) {
				new Notice('⚠️ Percorso assoluto non valido!');
				return;
			}
		}

		await this.saveData(this.settings);
	}

	onunload() {
		this.activeAbortControllers.forEach(controller => controller.abort());
		this.stylesEl?.remove();
	}
}

class DlvSettingTab extends PluginSettingTab {
	plugin: DlvPlugin;
	private typeDropdown: DropdownComponent;
	private absoluteSetting: Setting;
	private relativeSetting: Setting;

	constructor(app: App, plugin: DlvPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'DLV Plugin Settings' });

		// Tipo di installazione
		new Setting(containerEl)
			.setName('Installation Type')
			.setDesc('Select DLV executable location type')
			.addDropdown(dropdown => {
				this.typeDropdown = dropdown
					.addOption('absolute', 'Absolute Path')
					.addOption('relative', 'Relative to Plugin')
					.setValue(this.plugin.settings.dlvLocationType)
					.onChange(async (value) => {
						this.plugin.settings.dlvLocationType = value as "absolute" | "relative";
						await this.plugin.refreshExecutablesList();
						this.updateSettingsVisibility();
						await this.plugin.saveSettings();
					});
			});

		// Percorso assoluto
		this.absoluteSetting = new Setting(containerEl)
			.setName('Absolute Path')
			.setDesc('Full path to DLV executable (e.g. C:/dlv/dlv.exe)')
			.addText(text => text
				.setValue(this.plugin.settings.absolutePath)
				.onChange(async (value) => {
					this.plugin.settings.absolutePath = value;
					await this.plugin.saveSettings();
				}));

		// Percorso relativo
		this.relativeSetting = new Setting(containerEl)
			.setName('Plugin Executable')
			.setDesc('Select executable from plugin folder')
			.addDropdown(dropdown => {
				this.plugin.settings.availableExecutables.forEach(exe => {
					dropdown.addOption(exe, exe.split('/').pop() || exe);
				});
				dropdown
					.setValue(this.plugin.settings.relativeExecutable)
					.onChange(async (value) => {
						this.plugin.settings.relativeExecutable = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Execution Timeout')
			.setDesc('Maximum execution time in milliseconds (0 = no timeout)')
			.addText(text => text
				.setValue(this.plugin.settings.executionTimeout.toString())
				.onChange(async (value) => {
					const numValue = Math.max(0, parseInt(value) || 0);
					this.plugin.settings.executionTimeout = numValue;
					await this.plugin.saveSettings();
				}));

		// Altre impostazioni
		new Setting(containerEl)
			.setName('Supported File Extensions')
			.setDesc('Comma-separated list (e.g. asp,dlv,prolog)')
			.addText(text => text
				.setValue(this.plugin.settings.customExtensions)
				.onChange(async (value) => {
					this.plugin.settings.customExtensions = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show All Models')
			.setDesc('Enable -n 0 flag to show all answer sets')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showAllModels)
				.onChange(async (value) => {
					this.plugin.settings.showAllModels = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide Facts')
			.setDesc('Enable --no-facts flag to hide facts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideFacts)
				.onChange(async (value) => {
					this.plugin.settings.hideFacts = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Error Handling')
			.setDesc('Show error messages in output')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showErrors)
				.onChange(async (value) => {
					this.plugin.settings.showErrors = value;
					await this.plugin.saveSettings();
				}));

		this.updateSettingsVisibility();
	}

	private updateSettingsVisibility(): void {
		const isAbsolute = this.plugin.settings.dlvLocationType === "absolute";

		this.absoluteSetting.settingEl.style.display = isAbsolute ? "" : "none";
		this.relativeSetting.settingEl.style.display = isAbsolute ? "none" : "";

		// Aggiorna la lista nel dropdown
		const dropdown = this.relativeSetting.controlEl.querySelector('select');
		if (dropdown) {
			dropdown.innerHTML = this.plugin.settings.availableExecutables
				.map(exe => `<option value="${exe}">${path.basename(exe)}</option>`)
				.join('');
		}

		// Messaggio dettagliato
		const basePath = path.join(this.plugin.pluginPath, 'executables');
		const fileList = this.plugin.settings.availableExecutables
			.map(exe => `• ${path.basename(exe)}`)
			.join('\n');

		this.relativeSetting.descEl.innerHTML = `
            Percorso scannerizzato: <code>${basePath}</code><br>
            File trovati: ${this.plugin.settings.availableExecutables.length}
            <pre style="margin-top:5px">${fileList || 'Nessun file valido trovato'}</pre>
        `;
	}
}
