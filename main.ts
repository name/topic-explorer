import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, ViewStateResult } from 'obsidian';
import * as pluralize from 'pluralize'; // Import pluralize as a namespace

// Regular expression to find wikilinks
const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

// View type for our sidebar
const VIEW_TYPE_DEAD_LINKS = "dead-links-view";

interface TopicExplorerSettings {
	capitalizeLinks: boolean;
	singularizeLinks: boolean;
	useObsidianNewNoteLocation: boolean;
	customNewNoteFolder: string;
	useOllamaForGeneration: boolean;
	ollamaServerUrl: string;
	ollamaModel: string;
	ollamaTemperature: number;
	ollamaMaxTokens: number;
	ollamaTopK: number;
	ollamaTopP: number;
}

const DEFAULT_SETTINGS: TopicExplorerSettings = {
	capitalizeLinks: true,
	singularizeLinks: true,
	useObsidianNewNoteLocation: true,
	customNewNoteFolder: '',
	useOllamaForGeneration: false,
	ollamaServerUrl: 'http://localhost:11434',
	ollamaModel: 'llama2',
	ollamaTemperature: 0.8,
	ollamaMaxTokens: 200,
	ollamaTopK: 40,
	ollamaTopP: 0.9,
}

export default class TopicExplorer extends Plugin {
	settings: TopicExplorerSettings;
	deadLinksView: DeadLinksView;
	private refreshInterval: number;

	async onload() {
		await this.loadSettings();

		// Register the view type
		this.registerView(
			VIEW_TYPE_DEAD_LINKS,
			(leaf) => (this.deadLinksView = new DeadLinksView(leaf, this))
		);

		// Add a command to detect dead wikilinks in the current note
		this.addCommand({
			id: 'detect-dead-wikilinks',
			name: 'Detect Dead Wikilinks',
			callback: () => this.detectDeadWikilinks(),
			hotkeys: []
		});

		// Add a command to show the sidebar
		this.addCommand({
			id: 'show-dead-links-sidebar',
			name: 'Show Dead Links Sidebar',
			callback: () => this.activateView(),
			hotkeys: []
		});

		// Add a ribbon icon to show the sidebar
		this.addRibbonIcon('workflow', 'Dead Links Explorer', () => {
			this.activateView();
		});

		// Register for file open events to update the sidebar
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				if (this.deadLinksView) {
					this.deadLinksView.updateView();
				}
			})
		);

		// Add settings tab
		this.addSettingTab(new TopicExplorerSettingTab(this.app, this));

		// Activate the view if it was previously open
		if (this.app.workspace.layoutReady) {
			this.activateView();
		}

		// Set up interval to refresh the sidebar every 5 seconds
		this.refreshInterval = window.setInterval(() => {
			if (this.deadLinksView && this.deadLinksView.leaf) { // Check if view and leaf are valid
				this.deadLinksView.updateView();
			}
		}, 5000); // 5000 milliseconds = 5 seconds
	}

	async onunload() {
		// Clean up resources when plugin is disabled
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_DEAD_LINKS);

		// Clear the refresh interval when plugin is unloaded
		window.clearInterval(this.refreshInterval);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		// Check if view already exists
		const { workspace } = this.app;

		// If view already exists, show it
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_DEAD_LINKS)[0];

		if (!leaf) {
			// Create a new leaf in the right sidebar
			const rightLeaf = workspace.getRightLeaf(false);

			// Check if we got a valid leaf
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: VIEW_TYPE_DEAD_LINKS,
					active: true,
				});
				leaf = rightLeaf;
			} else {
				// Handle the case where we couldn't get a right leaf
				new Notice('Could not create sidebar view');
				return;
			}
		}

		// Reveal the leaf
		workspace.revealLeaf(leaf);

		// Update the view
		if (this.deadLinksView) {
			this.deadLinksView.updateView();
		}
	}

	async detectDeadWikilinks() {
		console.log("detectDeadWikilinks called"); // DEBUG: Log when this function is called
		const active_view = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!active_view) {
			new Notice('No active markdown view');
			return;
		}

		const editor = active_view.editor;
		const content = editor.getValue();

		// Add null check for file
		if (!active_view.file) {
			new Notice('No file is currently open');
			return;
		}
		const file_path = active_view.file.path;

		// Find all wikilinks in the document
		const wikilinks = [];
		let match;

		while ((match = WIKILINK_REGEX.exec(content)) !== null) {
			wikilinks.push(match[1]);
		}

		if (wikilinks.length === 0) {
			new Notice('No wikilinks found in the current note');
			return;
		}

		// Use Sets to store unique dead links and normalized links
		const deadLinksSet = new Set<string>();
		const normalizedLinksMap = new Map<string, string>(); // Original link -> Normalized link

		for (const link of wikilinks) {
			// Handle links with aliases by extracting the actual link target
			const link_target = link.includes('|') ? link.split('|')[0] : link;

			// Normalize the link according to rules
			const normalized_link = this.normalizeLink(link_target);

			// Store the mapping between original and normalized link
			if (normalized_link !== link_target) {
				normalizedLinksMap.set(link, normalized_link);
			}

			// Check if the file exists anywhere in the vault
			const file_exists = this.fileExistsInVault(normalized_link);

			if (!file_exists) {
				deadLinksSet.add(link); // Add to Set to ensure uniqueness
			}
		}

		// Apply normalizations first and check again for dead links
		if (normalizedLinksMap.size > 0) {
			const stillDeadLinksSet = new Set<string>(); // Use a Set for still dead links

			for (const link of deadLinksSet) { // Iterate over the Set
				const normalized = normalizedLinksMap.get(link) || link;
				const normalized_path = this.normalizeLinkPath(normalized);
				const file_exists = this.app.vault.getAbstractFileByPath(normalized_path) !== null;

				if (!file_exists) {
					stillDeadLinksSet.add(link); // Add to Set
				}
			}
			// Update deadLinksSet to only contain still dead links after normalization
			deadLinksSet.clear();
			stillDeadLinksSet.forEach(link => deadLinksSet.add(link));
		}


		// Convert Sets to Arrays for modal and view
		const dead_links = Array.from(deadLinksSet);
		const normalized_links = normalizedLinksMap;

		console.log("Dead links found:", dead_links); // DEBUG: Log dead links before modal
		console.log("Normalized links found:", normalized_links); // DEBUG: Log normalized links before modal


		if (dead_links.length === 0 && normalized_links.size === 0) {
			new Notice('No dead wikilinks or normalization suggestions found');
		} else {
			new DeadLinksModal(this.app, dead_links, normalized_links, this).open();
		}

		// Update the sidebar view if it's open
		if (this.deadLinksView) {
			this.deadLinksView.updateView();
		}
	}

	/**
	 * Checks if a file exists anywhere in the vault that matches the link
	 * @param link The link text to check
	 * @returns true if a matching file exists, false otherwise
	 */
	fileExistsInVault(link: string): boolean {
		// Extract the link text (without alias)
		const link_text = link.includes('|') ? link.split('|')[0] : link;

		// First, try the exact path
		const exact_path = this.normalizeLinkPath(link_text);
		if (this.app.vault.getAbstractFileByPath(exact_path)) {
			return true;
		}

		// If not found, search the entire vault for a matching file
		const all_files = this.app.vault.getAllLoadedFiles();

		// Check for files with matching names (case-insensitive)
		const matching_file = all_files.find(file => {
			if (file.path.endsWith('.md')) {
				// Get the filename without extension and path
				const filename = file.path.split('/').pop()?.replace('.md', '');

				// Compare case-insensitive
				return filename?.toLowerCase() === link_text.toLowerCase();
			}
			return false;
		});

		return !!matching_file;
	}

	normalizeLink(link: string): string {
		// Extract the link text and alias (if any)
		let link_text = link;
		let alias = '';

		if (link.includes('|')) {
			const parts = link.split('|');
			link_text = parts[0];
			alias = '|' + parts.slice(1).join('|');
		}

		let normalized = link_text;

		// Rule 1: Capitalize the first letter (if enabled)
		if (this.settings.capitalizeLinks) {
			normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
		}

		// Rule 2: Convert to singular form (if enabled)
		if (this.settings.singularizeLinks) {
			normalized = pluralize.singular(normalized); // Use pluralize namespace
		}

		// Rule 3: Context-specific bracketing is handled manually by the user
		// We can't automatically detect context differences

		// Reattach the alias if it exists
		return normalized + alias;
	}

	normalizeLinkPath(link: string): string {
		// Convert wikilink to a file path
		return `${link}.md`;
	}
}

class DeadLinksView extends ItemView {
	plugin: TopicExplorer;

	constructor(leaf: WorkspaceLeaf, plugin: TopicExplorer) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DEAD_LINKS;
	}

	getDisplayText(): string {
		return "Topic Explorer";
	}

	getIcon(): string {
		return "workflow";
	}

	async onOpen() {
		this.updateView();
	}

	async updateView() {
		console.log("updateView called"); // DEBUG: Log when updateView is called
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('topic-explorer-view'); // Add a class to the view for CSS

		const activeFile = this.app.workspace.getActiveFile();

		if (!activeFile) {
			contentEl.createEl('h2', { text: 'Topic Explorer' });
			contentEl.createEl('p', { text: 'No file is currently open.' });
			return; // Exit early if no file is open
		} else {
			contentEl.createEl('h2', { text: 'Topic Explorer - ' + activeFile.name.replace('.md', '') });
		}

		try {
			// Get the file content - now we know activeFile is not null
			const fileContent = await this.app.vault.read(activeFile);

			// Find all wikilinks
			const wikilinks = [];
			let match;
			const regex = new RegExp(WIKILINK_REGEX);

			while ((match = regex.exec(fileContent)) !== null) {
				wikilinks.push(match[1]);
			}

			if (wikilinks.length === 0) {
				contentEl.createEl('p', { text: 'No wikilinks found in this file.' });
				return;
			}

			// Use Sets to store unique dead links and normalized links
			const deadLinksSet = new Set<string>();
			const normalizedLinksMap = new Map<string, string>(); // Original link -> Normalized link


			for (const link of wikilinks) {
				// Handle links with aliases
				const link_target = link.includes('|') ? link.split('|')[0] : link;

				// Normalize the link
				const normalized_link = this.plugin.normalizeLink(link_target);

				// Store normalization if different
				if (normalized_link !== link_target) {
					normalizedLinksMap.set(link, normalized_link);
				}

				// Check if file exists
				const file_exists = this.plugin.fileExistsInVault(normalized_link);

				if (!file_exists) {
					deadLinksSet.add(link); // Use set to avoid duplicates
				}
			}

			// Convert Sets to Arrays for display
			const dead_links = Array.from(deadLinksSet);
			const normalized_links = normalizedLinksMap;

			console.log("Sidebar - Dead links:", dead_links); // DEBUG: Log dead links in sidebar
			console.log("Sidebar - Normalized links:", normalized_links); // DEBUG: Log normalized links in sidebar


			// Create a chat-like container
			const chatContainer = contentEl.createEl('div', { cls: 'topic-explorer-chat-container' });
			chatContainer.empty(); // Ensure container is empty

			if (normalized_links.size > 0) {
				chatContainer.createEl('h3', { text: 'Link Normalizations' });
				normalized_links.forEach((normalized, original) => {
					const messageItem = chatContainer.createEl('div', { cls: 'chat-message normalization-message' }); // normalization message
					messageItem.createEl('div', { text: `${original} → ${normalized}`, cls: 'chat-link-text' });

					const buttonGroup = messageItem.createEl('div', { cls: 'chat-button-group' });
					// Add a button to apply this normalization
					const applyBtn = buttonGroup.createEl('button', {
						text: 'Normalize',
						cls: 'mod-cta chat-button normalize-button' // normalize button
					});
					applyBtn.addEventListener('click', async () => {
						await this.applyNormalization(original, normalized);
						this.updateView();
					});
				});
			}

			if (dead_links.length > 0) {
				chatContainer.createEl('h3', { text: 'Dead Links' });
				dead_links.forEach((link) => {
					const normalized = normalized_links.get(link) || link;
					const messageItem = chatContainer.createEl('div', { cls: 'chat-message dead-link-message' }); // dead-link message

					const linkSpan = messageItem.createEl('div', { cls: 'chat-link-text' });
					if (normalized !== link) {
						linkSpan.setText(`${link} → ${normalized} (normalized)`);
					} else {
						linkSpan.setText(normalized);
					}

					const buttonGroup = messageItem.createEl('div', { cls: 'chat-button-group' });
					// Add a button to create the file
					const createBtn = buttonGroup.createEl('button', {
						text: 'Generate',
						cls: 'mod-cta chat-button generate-button' // generate button
					});
					createBtn.addEventListener('click', async () => {
						await this.createFile(normalized);
						this.updateView();
					});
				});
			}

			if (normalized_links.size === 0 && dead_links.length === 0) {
				chatContainer.createEl('p', { text: 'No dead links or normalizations found in this file.', cls: 'no-issues' });
			}

		} catch (error) {
			contentEl.createEl('p', { text: `Error reading file: ${error.message}` });
		}
	}

	async applyNormalization(original: string, normalized: string) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return;

		// Get the file content
		let content = await this.app.vault.read(activeFile);

		// Create a regex that matches the exact wikilink
		const linkRegex = new RegExp(`\\[\\[${this.escapeRegExp(original)}\\]\\]`, 'g');
		const newContent = content.replace(linkRegex, `[[${normalized}]]`);

		// Write the updated content back to the file
		await this.app.vault.modify(activeFile, newContent);

		new Notice(`Normalized: ${original} → ${normalized}`);
	}

	async applyAllNormalizations(normalizedLinks: Map<string, string>) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return;

		// Get the file content
		let content = await this.app.vault.read(activeFile);

		normalizedLinks.forEach((normalized, original) => {
			const linkRegex = new RegExp(`\\[\\[${this.escapeRegExp(original)}\\]\\]`, 'g');
			content = content.replace(linkRegex, `[[${normalized}]]`);
		});

		// Write the updated content back to the file
		await this.app.vault.modify(activeFile, content);

		new Notice(`Applied ${normalizedLinks.size} normalizations`);
	}

	async createFile(link: string) {
		// Extract the link text (without alias)
		const link_text = link.includes('|') ? link.split('|')[0] : link;

		try {
			// Get the folder where new notes should be created
			const newNoteFolderPath = this.getNewNoteFolder();

			// Combine the folder path with the file name
			const file_path = newNoteFolderPath && newNoteFolderPath !== '/'
				? `${newNoteFolderPath}/${link_text}.md`
				: `${link_text}.md`;

			// Create the file with a template
			const template = `# ${link_text}\n`;
			await this.app.vault.create(file_path, template);

			new Notice(`Created file: ${file_path}`);
			return true;
		} catch (error) {
			new Notice(`Error creating file: ${error.message}`);
			return false;
		}
	}

	getNewNoteFolder(): string {
		// If user has disabled using Obsidian's location, use the custom folder
		if (!this.plugin.settings.useObsidianNewNoteLocation) {
			return this.plugin.settings.customNewNoteFolder || '';
		}

		// Access the Obsidian config through app.fileManager
		const fileManager = this.app.fileManager;

		// Get the default folder for new notes
		try {
			// Get the active file
			const activeFile = this.app.workspace.getActiveFile();

			// Use Obsidian's internal method to get the folder for a new file
			if (activeFile) {
				const folder = fileManager.getNewFileParent(activeFile.path);
				return folder.path;
			}

			// If no active file, get the default location
			const folder = fileManager.getNewFileParent("");
			return folder.path === "/" ? "" : folder.path;
		} catch (error) {
			console.error("Error getting new note folder:", error);
			return '';
		}
	}

	escapeRegExp(string: string) {
		return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}

class DeadLinksModal extends Modal {
	dead_links: string[];
	normalized_links: Map<string, string>;
	plugin: TopicExplorer;

	constructor(app: App, dead_links: string[], normalized_links: Map<string, string>, plugin: TopicExplorer) {
		super(app);
		this.dead_links = dead_links;
		this.normalized_links = normalized_links;
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('dead-links-modal');
		contentEl.createEl('h2', { text: 'Dead Wikilinks Found' });

		// Show normalized links if any
		if (this.normalized_links.size > 0) {
			contentEl.createEl('h3', { text: 'Suggested Link Normalizations' });
			const normList = contentEl.createEl('ul');

			this.normalized_links.forEach((normalized, original) => {
				const item = normList.createEl('li');
				item.createSpan({ text: `${original} → ${normalized}` });

				// Add a button to apply this specific normalization
				const applyBtn = item.createEl('button', {
					text: 'Apply',
					cls: 'mod-cta'
				});
				applyBtn.style.marginLeft = '10px';
				applyBtn.addEventListener('click', () => {
					this.applyNormalization(original, normalized);
				});
			});

			// Add a button to apply all normalizations
			if (this.normalized_links.size > 1) {
				const applyAllBtn = contentEl.createEl('button', {
					text: 'Apply All Normalizations',
					cls: 'mod-cta'
				});
				applyAllBtn.style.marginTop = '10px';
				applyAllBtn.addEventListener('click', () => {
					this.applyAllNormalizations();
				});
			}

			contentEl.createEl('hr');
		}

		contentEl.createEl('h3', { text: 'Dead Links' });
		const list = contentEl.createEl('ul');

		// If no dead links after normalization, show a message
		if (this.dead_links.length === 0) {
			list.createEl('li', { text: 'No dead links found after normalization' });
			return;
		}

		for (const link of this.dead_links) {
			const normalized = this.normalized_links.get(link) || link;
			const item = list.createEl('li');

			const linkSpan = item.createSpan();
			if (normalized !== link) {
				linkSpan.setText(`${link} → ${normalized} (normalized)`);
			} else {
				linkSpan.setText(normalized);
			}

			// Add a button to create the file
			const createBtn = item.createEl('button', {
				text: 'Create File',
				cls: 'mod-cta'
			});
			createBtn.style.marginLeft = '10px';
			createBtn.addEventListener('click', async () => {
				await this.createFile(normalized);

				// Remove this item from the list
				item.remove();

				// Remove from dead_links array
				const index = this.dead_links.indexOf(link);
				if (index > -1) {
					this.dead_links.splice(index, 1);
				}

				// If no more dead links, close the modal or update the message
				if (this.dead_links.length === 0) {
					list.empty();
					list.createEl('li', { text: 'All dead links have been resolved!' });
				}
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	applyNormalization(original: string, normalized: string) {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

		const editor = activeView.editor;
		const content = editor.getValue();

		// Create a regex that matches the exact wikilink
		const linkRegex = new RegExp(`\\[\\[${this.escapeRegExp(original)}\\]\\]`, 'g');
		const newContent = content.replace(linkRegex, `[[${normalized}]]`);

		editor.setValue(newContent);
		new Notice(`Normalized: ${original} → ${normalized}`);

		// Refresh the dead links check
		this.refreshDeadLinks();
	}

	applyAllNormalizations() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

		const editor = activeView.editor;
		let content = editor.getValue();

		this.normalized_links.forEach((normalized, original) => {
			const linkRegex = new RegExp(`\\[\\[${this.escapeRegExp(original)}\\]\\]`, 'g');
			content = content.replace(linkRegex, `[[${normalized}]]`);
		});

		editor.setValue(content);
		new Notice(`Applied ${this.normalized_links.size} normalizations`);

		// Refresh the dead links check
		this.refreshDeadLinks();
	}

	async createFile(link: string) {
		// Extract the link text (without alias)
		const link_text = link.includes('|') ? link.split('|')[0] : link;

		try {
			// Get the folder where new notes should be created
			const newNoteFolderPath = this.getNewNoteFolder();

			// Combine the folder path with the file name
			const file_path = newNoteFolderPath && newNoteFolderPath !== '/'
				? `${newNoteFolderPath}/${link_text}.md`
				: `${link_text}.md`;

			// Create the file with the template from settings
			const template = `# ${link_text}\n`;
			await this.app.vault.create(file_path, template);

			new Notice(`Created file: ${file_path}`);
			return true;
		} catch (error) {
			new Notice(`Error creating file: ${error.message}`);
			return false;
		}
	}

	/**
	 * Gets the folder path where new notes should be created based on settings
	 * @returns The folder path or empty string for vault root
	 */
	getNewNoteFolder(): string {
		// If user has disabled using Obsidian's location, use the custom folder
		if (!this.plugin.settings.useObsidianNewNoteLocation) {
			return this.plugin.settings.customNewNoteFolder || '';
		}

		// Access the Obsidian config through app.fileManager
		const fileManager = this.app.fileManager;

		// Get the default folder for new notes
		try {
			// Get the active file
			const activeFile = this.app.workspace.getActiveFile();

			// Use Obsidian's internal method to get the folder for a new file
			if (activeFile) {
				const folder = fileManager.getNewFileParent(activeFile.path);
				return folder.path;
			}

			// If no active file, get the default location
			const folder = fileManager.getNewFileParent("");
			return folder.path === "/" ? "" : folder.path;
		} catch (error) {
			console.error("Error getting new note folder:", error);
			return '';
		}
	}

	async refreshDeadLinks() {
		// Close this modal
		this.close();

		// Re-run the dead links detection
		await this.plugin.detectDeadWikilinks();
	}

	escapeRegExp(string: string) {
		return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}

class TopicExplorerSettingTab extends PluginSettingTab {
	plugin: TopicExplorer;

	constructor(app: App, plugin: TopicExplorer) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Topic Explorer Settings' });

		// Link Normalization Settings
		containerEl.createEl('h3', { text: 'Link Normalization' });

		new Setting(containerEl)
			.setName('Capitalize links')
			.setDesc('Automatically capitalize the first letter of each link')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.capitalizeLinks)
				.onChange(async (value) => {
					this.plugin.settings.capitalizeLinks = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Singularize links')
			.setDesc('Convert plural forms to singular (e.g., "Cows" to "Cow")')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.singularizeLinks)
				.onChange(async (value) => {
					this.plugin.settings.singularizeLinks = value;
					await this.plugin.saveSettings();
				}));

		// New Note Location Settings
		containerEl.createEl('h3', { text: 'New Note Location' });

		new Setting(containerEl)
			.setName('Use Obsidian\'s new note location')
			.setDesc('Follow Obsidian\'s settings for where to create new notes')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useObsidianNewNoteLocation)
				.onChange(async (value) => {
					this.plugin.settings.useObsidianNewNoteLocation = value;
					await this.plugin.saveSettings();
					// Refresh the display to show/hide the custom folder setting
					this.display();
				}));

		// Only show custom folder setting if not using Obsidian's location
		if (!this.plugin.settings.useObsidianNewNoteLocation) {
			new Setting(containerEl)
				.setName('Custom new note folder')
				.setDesc('Specify a custom folder for new notes (leave empty for vault root)')
				.addText(text => text
					.setPlaceholder('Example: Folder/Subfolder')
					.setValue(this.plugin.settings.customNewNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.customNewNoteFolder = value;
						await this.plugin.saveSettings();
					}));
		}

		// Ollama Settings
		containerEl.createEl('h3', { text: 'Ollama Settings' });

		new Setting(containerEl)
			.setName('Use Ollama for Generation')
			.setDesc('Enable Ollama for generating new notes and content.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useOllamaForGeneration)
				.onChange(async (value) => {
					this.plugin.settings.useOllamaForGeneration = value;
					await this.plugin.saveSettings();
					// Refresh the display to show/hide Ollama settings
					this.display();
				}));

		if (this.plugin.settings.useOllamaForGeneration) {
			new Setting(containerEl)
				.setName('Ollama Server URL')
				.setDesc('URL of your Ollama server.')
				.addText(text => text
					.setPlaceholder('http://localhost:11434')
					.setValue(this.plugin.settings.ollamaServerUrl)
					.onChange(async (value) => {
						this.plugin.settings.ollamaServerUrl = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Ollama Model')
				.setDesc('Specify the Ollama model to use.')
				.addText(text => text
					.setPlaceholder('Enter model name')
					.setValue(this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
					}));

			// Ollama Temperature Slider
			new Setting(containerEl)
				.setName('Temperature')
				.setDesc('Adjust the randomness of the model\'s output.')
				.addSlider(slider => slider
					.setLimits(0, 1, 0.1)
					.setValue(this.plugin.settings.ollamaTemperature)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ollamaTemperature = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Max Tokens')
				.setDesc('Maximum number of tokens in the generated text.')
				.addText(text => text
					.setPlaceholder('Enter max tokens')
					.setValue(String(this.plugin.settings.ollamaMaxTokens))
					.onChange(async (value) => {
						const parsedValue = parseInt(value, 10);
						if (!isNaN(parsedValue)) {
							this.plugin.settings.ollamaMaxTokens = parsedValue;
							await this.plugin.saveSettings();
						} else {
							new Notice('Please enter a valid integer for Max Tokens');
							text.setValue(String(this.plugin.settings.ollamaMaxTokens));
						}
					}));

			new Setting(containerEl)
				.setName('Top K')
				.setDesc('Number of most likely tokens to consider (higher = more diverse)')
				.addText(text => text
					.setPlaceholder('Enter integer value')
					.setValue(String(this.plugin.settings.ollamaTopK))
					.onChange(async (value) => {
						const parsedValue = parseInt(value, 10);
						if (!isNaN(parsedValue)) {
							this.plugin.settings.ollamaTopK = parsedValue;
							await this.plugin.saveSettings();
						} else {
							new Notice('Please enter a valid integer for Top-K');
							text.setValue(String(this.plugin.settings.ollamaTopK));
						}
					}));

			// Ollama Top-P Slider
			new Setting(containerEl)
				.setName('Top P')
				.setDesc('Probability threshold for token selection (higher = more diverse)')
				.addSlider(slider => slider
					.setLimits(0.0, 1.0, 0.05)
					.setValue(this.plugin.settings.ollamaTopP)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.ollamaTopP = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Test Connection')
				.setDesc('Test the connection to your Ollama server.')
				.addButton(button => button
					.setButtonText('Test Connection')
					.onClick(async () => {
						try {
							const response = await fetch(`${this.plugin.settings.ollamaServerUrl}/api/tags`, {
								method: 'GET',
								headers: {
									'Content-Type': 'application/json'
								}
							});

							if (response.ok) {
								const data = await response.json();
								if (data.models) {
									new Notice('✅ Connection successful!');
								} else {
									new Notice('⚠️ Connected but no models found');
								}
							} else {
								new Notice('❌ Connection failed: ' + response.statusText);
							}
						} catch (error) {
							new Notice('❌ Connection error: ' + error.message);
						}
					}));
		}
	}
}
