import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TAbstractFile,
  TFolder,
  requestUrl,
  setIcon,
  ItemView,
  WorkspaceLeaf,
  Menu,
  FileSystemAdapter,
} from "obsidian";

// Константы
const VIEW_TYPE_CHAT = "doc-summarize-chat-view";

// Интерфейс настроек плагина
interface DocSummarizeSettings {
  lmStudioUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  summarizePrompt: string;
  questionPrompt: string;
  includeLinkedNotes: boolean;
  maxLinkedNotesDepth: number;
  language: string;
  includeFolders?: string[]; // Новое поле: выбранные папки
  maxContextLength: number; // Максимальная длина контекста в символах
  useMapReduce: boolean; // Использовать Map-Reduce для больших наборов документов
  includeTags?: string[]; // Фильтр по тегам
  maxFileAge?: number; // Максимальный возраст файлов в днях (0 - все)
  useFileIndex: boolean; // Использовать индекс файлов вместо полного контента
  maxIndexFiles?: number; // Максимальное количество файлов в индексе
}

// Настройки по умолчанию
const DEFAULT_SETTINGS: DocSummarizeSettings = {
  lmStudioUrl: "http://localhost:1234/v1",
  model: "",
  maxTokens: 2048,
  temperature: 0.7,
  summarizePrompt: `Ты - помощник для суммаризации документов. Создай краткое и информативное резюме следующего текста на русском языке. Выдели ключевые моменты и основные идеи.`,
  questionPrompt: `Ты - помощник для ответов на вопросы о заметках. Используй предоставленный контекст для ответа. Если в контексте есть ссылки на другие заметки, упоминай их в формате [[название заметки]] или [[название документа]]. Отвечай на русском языке.`,
  includeLinkedNotes: true,
  maxLinkedNotesDepth: 1,
  language: "ru",
  maxContextLength: 4000, // Максимальная длина контекста в символах
  useMapReduce: false, // Использовать Map-Reduce для больших наборов документов
  maxFileAge: 0, // Максимальный возраст файлов в днях (0 - все)
  useFileIndex: true, // Использовать индекс файлов вместо полного контента
  maxIndexFiles: 50, // Максимальное количество файлов в индексе
};

// Интерфейс сообщения чата
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
}

// Интерфейс модели LM Studio
interface LMStudioModel {
  id: string;
  object: string;
  owned_by: string;
}

// Интерфейс прикреплённого файла
interface AttachedFile {
  name: string;
  type: "note" | "image" | "file";
  content?: string;
  base64?: string;
  mimeType?: string;
  path: string;
}

// Основной класс плагина
export default class DocSummarizePlugin extends Plugin {
  settings: DocSummarizeSettings;
  availableModels: LMStudioModel[] = [];

  async onload() {
    await this.loadSettings();

    // Регистрируем view для боковой панели
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatSidebarView(leaf, this));

    // Добавляем иконку на боковую панель (ribbon)
    this.addRibbonIcon("message-square", "Doc Summarize Chat", () => {
      this.activateChatView();
    });

    // Команда: Открыть чат в боковой панели
    this.addCommand({
      id: "open-chat-sidebar",
      name: "Открыть чат в боковой панели",
      callback: () => {
        this.activateChatView();
      },
    });

    // Команда: Суммаризировать текущий документ
    this.addCommand({
      id: "summarize-current-document",
      name: "Суммаризировать текущий документ",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const content = editor.getValue();
        const file = view.file;
        this.summarizeContent(content, file?.basename || "Документ");
      },
    });

    // Команда: Суммаризировать выделенный текст
    this.addCommand({
      id: "summarize-selection",
      name: "Суммаризировать выделенный текст",
      editorCallback: (editor: Editor) => {
        const selection = editor.getSelection();
        if (selection) {
          this.summarizeContent(selection, "Выделенный текст");
        } else {
          new Notice("Сначала выделите текст для суммаризации");
        }
      },
    });

    // Команда: Задать вопрос о документе
    this.addCommand({
      id: "ask-about-document",
      name: "Задать вопрос о документе",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const content = editor.getValue();
        const file = view.file;
        new ChatModal(this.app, this, content, file).open();
      },
    });

    // Команда: Суммаризировать изображение
    this.addCommand({
      id: "summarize-image",
      name: "Описать/суммаризировать изображение",
      callback: () => {
        new ImageSummarizeModal(this.app, this).open();
      },
    });

    // Команда: Быстрый вопрос о всех заметках
    this.addCommand({
      id: "ask-about-vault",
      name: "Задать вопрос о заметках (поиск по vault)",
      callback: () => {
        new VaultChatModal(this.app, this).open();
      },
    });

    // Команда: Вставить суммаризацию в документ
    this.addCommand({
      id: "insert-summary",
      name: "Вставить суммаризацию в документ",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const content = editor.getValue();
        const summary = await this.getSummary(content);
        if (summary) {
          const cursor = editor.getCursor();
          editor.replaceRange(
            `\n\n---\n## Суммаризация\n\n${summary}\n\n---\n`,
            cursor
          );
          new Notice("Суммаризация добавлена в документ");
        }
      },
    });

    // Добавляем вкладку настроек
    this.addSettingTab(new DocSummarizeSettingTab(this.app, this));

    // Добавляем элемент в статус-бар
    const statusBarItem = this.addStatusBarItem();
    statusBarItem.addClass("doc-summarize-status");
    this.updateStatusBar(statusBarItem);

    // Загружаем список моделей при старте
    this.loadAvailableModels();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  // Активация боковой панели чата
  async activateChatView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Получение списка доступных моделей
  async loadAvailableModels(): Promise<LMStudioModel[]> {
    try {
      const response = await requestUrl({
        url: `${this.settings.lmStudioUrl}/models`,
        method: "GET",
      });

      if (response.status === 200) {
        const data = response.json;
        this.availableModels = data.data || [];
        
        // Если модель не выбрана, выбираем первую доступную
        if (!this.settings.model && this.availableModels.length > 0) {
          this.settings.model = this.availableModels[0].id;
          await this.saveSettings();
        }
        
        return this.availableModels;
      }
    } catch (error) {
      console.error("Ошибка загрузки моделей:", error);
    }
    return [];
  }

  // Проверка подключения к LM Studio
  async checkConnection(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.settings.lmStudioUrl}/models`,
        method: "GET",
      });
      return response.status === 200;
    } catch (error) {
      console.error("LM Studio connection error:", error);
      return false;
    }
  }

  // Обновление статус-бара
  async updateStatusBar(statusBarItem: HTMLElement) {
    const connected = await this.checkConnection();
    statusBarItem.empty();
    
    const dot = statusBarItem.createSpan({ cls: "doc-summarize-status-dot" });
    dot.addClass(connected ? "connected" : "disconnected");
    
    statusBarItem.createSpan({ text: connected ? "LM Studio" : "LM Studio (offline)" });
  }

  // Отправка запроса к LM Studio API
  async sendToLMStudio(
    messages: ChatMessage[],
    onStream?: (text: string) => void
  ): Promise<string> {
    try {
      const requestBody: any = {
        model: this.settings.model,
        messages: messages.map((m) => {
          if (m.images && m.images.length > 0) {
            return {
              role: m.role,
              content: [
                { type: "text", text: m.content },
                ...m.images.map((img) => ({
                  type: "image_url",
                  image_url: { url: img },
                })),
              ],
            };
          }
          return { role: m.role, content: m.content };
        }),
        max_tokens: this.settings.maxTokens,
        temperature: this.settings.temperature,
        stream: !!onStream,
      };

      if (onStream) {
        // Обработка стрима
        const response = await fetch(`${this.settings.lmStudioUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          throw new Error(`API Error: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        let fullContent = "";
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") continue;

              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || "";
                if (content) {
                  fullContent += content;
                  onStream(fullContent);
                }
              } catch (e) {
                // Игнорируем невалидный JSON
              }
            }
          }
        }

        return fullContent;
      } else {
        // Обычный запрос
        const response = await requestUrl({
          url: `${this.settings.lmStudioUrl}/chat/completions`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (response.status !== 200) {
          throw new Error(`API Error: ${response.status}`);
        }

        const data = response.json;
        return data.choices[0]?.message?.content || "";
      }
    } catch (error) {
      console.error("LM Studio API error:", error);
      throw error;
    }
  }

  // Получение суммаризации
  async getSummary(content: string): Promise<string | null> {
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: this.settings.summarizePrompt },
        { role: "user", content: content },
      ];

      return await this.sendToLMStudio(messages);
    } catch (error) {
      new Notice("Ошибка при суммаризации. Проверьте подключение к LM Studio.");
      return null;
    }
  }

  // Суммаризация контента с показом модального окна
  async summarizeContent(content: string, title: string) {
    new SummaryModal(this.app, this, content, title).open();
  }

  // Получение связанных заметок
  async getLinkedNotes(file: TFile, depth: number = 1): Promise<Map<string, string>> {
    const linkedNotes = new Map<string, string>();
    
    if (depth <= 0) return linkedNotes;

    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.links) return linkedNotes;

    for (const link of cache.links) {
      const linkedFile = this.app.metadataCache.getFirstLinkpathDest(
        link.link,
        file.path
      );
      
      if (linkedFile && linkedFile instanceof TFile && !linkedNotes.has(linkedFile.path)) {
        const content = await this.app.vault.read(linkedFile);
        linkedNotes.set(linkedFile.path, `## ${linkedFile.basename}\n\n${content}`);
        
        if (depth > 1) {
          const nestedLinks = await this.getLinkedNotes(linkedFile, depth - 1);
          nestedLinks.forEach((value, key) => {
            if (!linkedNotes.has(key)) {
              linkedNotes.set(key, value);
            }
          });
        }
      }
    }

    return linkedNotes;
  }

  // Поиск заметок по запросу
  async searchNotes(query: string): Promise<TFile[]> {
    const files = this.app.vault.getMarkdownFiles();
    const results: { file: TFile; score: number }[] = [];
    
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    for (const file of files) {
      let score = 0;
      const content = await this.app.vault.cachedRead(file);
      const contentLower = content.toLowerCase();
      const titleLower = file.basename.toLowerCase();

      // Проверка заголовка
      for (const word of queryWords) {
        if (titleLower.includes(word)) score += 10;
        if (contentLower.includes(word)) score += 1;
      }

      if (score > 0) {
        results.push({ file, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 5).map((r) => r.file);
  }

  // Чтение файла как base64 для изображений
  async readFileAsBase64(file: TFile): Promise<string> {
    const arrayBuffer = await this.app.vault.readBinary(file);
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < uint8Array.byteLength; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  // Определение MIME типа по расширению
  getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      "png": "image/png",
      "jpg": "image/jpeg",
      "jpeg": "image/jpeg",
      "gif": "image/gif",
      "webp": "image/webp",
      "svg": "image/svg+xml",
      "bmp": "image/bmp",
    };
    return mimeTypes[extension.toLowerCase()] || "image/png";
  }

  // Проверка, является ли файл изображением
  isImageFile(file: TFile): boolean {
    const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
    return imageExtensions.includes(file.extension.toLowerCase());
  }
}

// ==================== БОКОВАЯ ПАНЕЛЬ ЧАТА ====================

class ChatSidebarView extends ItemView {
  plugin: DocSummarizePlugin;
  messages: ChatMessage[] = [];
  attachedFiles: AttachedFile[] = [];
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  attachmentsEl: HTMLElement;
  commandHistory: string[] = [];
  historyIndex: number = -1;

  constructor(leaf: WorkspaceLeaf, plugin: DocSummarizePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText() {
    return "Doc Summarize Chat";
  }

  getIcon() {
    return "message-square";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("doc-summarize-sidebar");

    // Заголовок
    const headerEl = container.createDiv({ cls: "doc-summarize-sidebar-header" });
    
    const titleEl = headerEl.createDiv({ cls: "doc-summarize-sidebar-title" });
    setIcon(titleEl.createSpan(), "message-square");
    titleEl.createSpan({ text: " Doc Summarize" });

    // Кнопки в заголовке
    const headerActions = headerEl.createDiv({ cls: "doc-summarize-header-actions" });
    
    const saveBtn = headerActions.createEl("button", { cls: "doc-summarize-icon-btn", attr: { "aria-label": "Сохранить чат как заметку" } });
    setIcon(saveBtn, "save");
    saveBtn.onclick = () => this.saveChatAsNote();

    const clearBtn = headerActions.createEl("button", { cls: "doc-summarize-icon-btn", attr: { "aria-label": "Очистить чат" } });
    setIcon(clearBtn, "trash-2");
    clearBtn.onclick = () => this.clearChat();

    const addCurrentBtn = headerActions.createEl("button", { cls: "doc-summarize-icon-btn", attr: { "aria-label": "Добавить текущую заметку" } });
    setIcon(addCurrentBtn, "file-plus");
    addCurrentBtn.onclick = () => this.addCurrentNote();

    // Область прикреплённых файлов
    this.attachmentsEl = container.createDiv({ cls: "doc-summarize-attachments" });

    // Область сообщений
    this.messagesEl = container.createDiv({ cls: "doc-summarize-messages" });

    // Приветственное сообщение
    this.addMessageToUI("system", "👋 Привет! Я могу помочь с вашими заметками, изображениями и документами.\n\n📎 Прикрепите файлы кнопками ниже или перетащите их сюда.\n\n💡 Используйте кнопку ➕ чтобы добавить текущую заметку.");

    // Панель добавления файлов
    const addFilesPanel = container.createDiv({ cls: "doc-summarize-add-files-panel" });
    
    const addNoteBtn = addFilesPanel.createEl("button", { cls: "doc-summarize-add-file-btn" });
    setIcon(addNoteBtn, "file-text");
    addNoteBtn.createSpan({ text: " Заметка" });
    addNoteBtn.onclick = () => this.showNoteSelector();

    const addImageBtn = addFilesPanel.createEl("button", { cls: "doc-summarize-add-file-btn" });
    setIcon(addImageBtn, "image");
    addImageBtn.createSpan({ text: " Изображение" });
    addImageBtn.onclick = () => this.showImageSelector();

    const addFromVaultBtn = addFilesPanel.createEl("button", { cls: "doc-summarize-add-file-btn" });
    setIcon(addFromVaultBtn, "folder-open");
    addFromVaultBtn.createSpan({ text: " Из vault" });
    addFromVaultBtn.onclick = () => this.showFileSelector();

    const addFolderBtn = addFilesPanel.createEl("button", { cls: "doc-summarize-add-file-btn" });
    setIcon(addFolderBtn, "folder");
    addFolderBtn.createSpan({ text: "Папку" });
    addFolderBtn.onclick = () => this.showFolderSelector();

    const addAllBtn = addFilesPanel.createEl("button", { cls: "doc-summarize-add-file-btn doc-summarize-add-all-btn" });
    setIcon(addAllBtn, "files");
    addAllBtn.createSpan({ text: " Все файлы" });
    addAllBtn.onclick = () => this.addAllNotes();

    // Область ввода
    const inputArea = container.createDiv({ cls: "doc-summarize-input-area" });
    
    this.inputEl = inputArea.createEl("textarea", {
      placeholder: "Задайте вопрос о прикреплённых файлах...",
    });
    
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      } else if (e.key === "ArrowUp" && this.historyIndex === -1 && this.inputEl.value === "") {
        // Показать последний запрос из истории
        if (this.commandHistory.length > 0) {
          this.historyIndex = this.commandHistory.length - 1;
          this.inputEl.value = this.commandHistory[this.historyIndex];
        }
        e.preventDefault();
      } else if (e.key === "ArrowUp" && this.historyIndex > 0) {
        // Перейти к предыдущему запросу
        this.historyIndex--;
        this.inputEl.value = this.commandHistory[this.historyIndex];
        e.preventDefault();
      } else if (e.key === "ArrowDown" && this.historyIndex >= 0 && this.historyIndex < this.commandHistory.length - 1) {
        // Перейти к следующему запросу
        this.historyIndex++;
        this.inputEl.value = this.commandHistory[this.historyIndex];
        e.preventDefault();
      } else if (e.key === "ArrowDown" && this.historyIndex === this.commandHistory.length - 1) {
        // Вернуться к пустому полю
        this.historyIndex = -1;
        this.inputEl.value = "";
        e.preventDefault();
      }
    });

    this.sendBtn = inputArea.createEl("button", {
      cls: "doc-summarize-send-btn",
    });
    setIcon(this.sendBtn, "send");
    this.sendBtn.onclick = () => this.sendMessage();

    // Поддержка drag and drop
    this.setupDragAndDrop(container as HTMLElement);
  }

  setupDragAndDrop(container: HTMLElement) {
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      container.addClass("doc-summarize-dragover");
    });

    container.addEventListener("dragleave", () => {
      container.removeClass("doc-summarize-dragover");
    });

    container.addEventListener("drop", async (e) => {
      e.preventDefault();
      container.removeClass("doc-summarize-dragover");

      // Обработка перетаскивания из Obsidian
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          await this.addExternalFile(files[i]);
        }
      }

      // Обработка внутренних ссылок Obsidian
      const text = e.dataTransfer?.getData("text/plain");
      if (text) {
        const file = this.app.vault.getAbstractFileByPath(text);
        if (file instanceof TFile) {
          await this.attachFile(file);
        }
      }
    });
  }

  async addExternalFile(file: File) {
    // Проверяем, не прикреплён ли уже файл с таким же именем
    if (this.attachedFiles.some((f) => f.name === file.name)) {
      new Notice(`Файл "${file.name}" уже прикреплён`);
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1];
      const isImage = file.type.startsWith("image/");

      const attached: AttachedFile = {
        name: file.name,
        type: isImage ? "image" : "file",
        path: file.name,
        base64: isImage ? base64 : undefined,
        mimeType: file.type,
        content: isImage ? undefined : atob(base64),
      };

      this.attachedFiles.push(attached);
      this.updateAttachmentsUI();
    };
    reader.readAsDataURL(file);
  }

  async addCurrentNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file) {
      await this.attachFile(view.file);
      new Notice(`Добавлена заметка: ${view.file.basename}`);
    } else {
      new Notice("Откройте заметку для добавления");
    }
  }

  async attachFile(file: TFile) {
    // Проверяем, не прикреплён ли уже файл с таким же путём или именем
    if (this.attachedFiles.some((f) => f.path === file.path || f.name === file.basename)) {
      new Notice("Файл уже прикреплён");
      return;
    }

    if (this.plugin.isImageFile(file)) {
      const base64 = await this.plugin.readFileAsBase64(file);
      const mimeType = this.plugin.getMimeType(file.extension);
      
      this.attachedFiles.push({
        name: file.basename,
        type: "image",
        path: file.path,
        base64: base64,
        mimeType: mimeType,
      });
    } else {
      const content = await this.app.vault.read(file);
      
      this.attachedFiles.push({
        name: file.basename,
        type: "note",
        path: file.path,
        content: content,
      });
    }

    this.updateAttachmentsUI();
  }

  updateAttachmentsUI() {
    this.attachmentsEl.empty();

    if (this.attachedFiles.length === 0) {
      return;
    }

    const label = this.attachmentsEl.createDiv({ cls: "doc-summarize-attachments-label" });
    label.setText(`📎 Прикреплено (${this.attachedFiles.length}):`);

    const list = this.attachmentsEl.createDiv({ cls: "doc-summarize-attachments-list" });

    for (const file of this.attachedFiles) {
      const chip = list.createDiv({ cls: "doc-summarize-attachment-chip" });
      
      const icon = file.type === "image" ? "image" : "file-text";
      setIcon(chip.createSpan({ cls: "doc-summarize-attachment-icon" }), icon);
      
      chip.createSpan({ text: file.name, cls: "doc-summarize-attachment-name" });
      
      const removeBtn = chip.createSpan({ cls: "doc-summarize-attachment-remove" });
      setIcon(removeBtn, "x");
      removeBtn.onclick = () => {
        this.attachedFiles = this.attachedFiles.filter((f) => f.path !== file.path);
        this.updateAttachmentsUI();
      };
    }
  }

  showNoteSelector() {
    const modal = new NoteSelectorModal(this.app, async (file) => {
      await this.attachFile(file);
    });
    modal.open();
  }

  showImageSelector() {
    const modal = new ImageSelectorModal(this.app, this.plugin, async (file) => {
      await this.attachFile(file);
    });
    modal.open();
  }

  showFileSelector() {
    const modal = new FileSelectorModal(this.app, this.plugin, async (file) => {
      await this.attachFile(file);
    });
    modal.open();
  }

  showFolderSelector() {
    const folders = this.app.vault.getAllLoadedFiles()
      .filter(f => f instanceof TFolder)
      .map(f => f.path);
    
    const modal = new FolderSelectorModal(this.app, async (folderPath) => {
      const files = this.app.vault.getFiles().filter(f => f.path.startsWith(folderPath + "/") || f.path === folderPath);
      for (const file of files) {
        if (!this.plugin.isImageFile(file)) {
          await this.attachFile(file);
        }
      }
      new Notice(`Добавлено ${files.length} файлов из папки ${folderPath}`);
    });
    modal.open();
  }

  async addAllNotes() {
    const files = this.app.vault.getFiles();
    if (files.length === 0) {
      new Notice("Нет файлов в хранилище (vault)");
      return;
    }

    if (files.length > 50) {
      const confirm = await this.showConfirmModal(
        `Добавить все ${files.length} файлов?`,
        "Это может занять время и использовать много контекста модели."
      );
      if (!confirm) return;
    }

    new Notice(`Добавляю все файлы...`);

    // Получаем максимальный размер контекста
    const maxContextLength = this.plugin.settings.maxContextLength;

    // Собираем текстовое содержимое всех файлов (без картинок и видео), с учетом выбранных папок
    const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
    const videoExts = ["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg"];
    let textFiles = files.filter(file => {
      const ext = file.extension.toLowerCase();
      return !imageExts.includes(ext) && !videoExts.includes(ext);
    });
    new Notice(`Найдено ${textFiles.length} текстовых файлов`);

    // Фильтрация по выбранным папкам, если указаны
    if (this.plugin.settings.includeFolders && this.plugin.settings.includeFolders.length > 0) {
      textFiles = textFiles.filter(file =>
        this.plugin.settings.includeFolders!.some(folder => file.path.startsWith(folder + "/") || file.path === folder)
      );
      new Notice(`После фильтрации по папкам: ${textFiles.length} файлов`);
    }

    // Фильтрация по тегам, если указаны
    if (this.plugin.settings.includeTags && this.plugin.settings.includeTags.length > 0) {
      textFiles = textFiles.filter(file => {
        const cache = this.app.metadataCache.getFileCache(file);
        const tags = cache?.frontmatter?.tags || [];
        return this.plugin.settings.includeTags!.some(tag => tags.includes(tag));
      });
      new Notice(`После фильтрации по тегам: ${textFiles.length} файлов`);
    }

    // Фильтрация по возрасту файлов
    if (this.plugin.settings.maxFileAge && this.plugin.settings.maxFileAge > 0) {
      const now = Date.now();
      const maxAgeMs = this.plugin.settings.maxFileAge * 24 * 60 * 60 * 1000;
      textFiles = textFiles.filter(file => now - file.stat.mtime < maxAgeMs);
      new Notice(`После фильтрации по возрасту: ${textFiles.length} файлов`);
    }

    // Сортируем файлы по дате изменения (новые сначала)
    textFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

    // Добавляем файлы
    this.attachedFiles = [];
    if (this.plugin.settings.useFileIndex) {
      // Создаем динамический индекс файлов
      let indexContent = "=== ИНДЕКС ФАЙЛОВ VAULT ===\n\n";
      
      // Ограничиваем количество файлов
      let filesToIndex = textFiles;
      if (this.plugin.settings.maxIndexFiles && this.plugin.settings.maxIndexFiles > 0) {
        filesToIndex = textFiles.slice(0, this.plugin.settings.maxIndexFiles);
      }
      
      // Вычисляем доступное место для превью
      const baseInfoPerFile = 100; // Примерная длина базовой информации на файл
      const totalBaseInfo = filesToIndex.length * baseInfoPerFile;
      const availableForPreview = Math.max(0, maxContextLength - totalBaseInfo - 200); // Резерв для заголовка
      const previewLengthPerFile = Math.floor(availableForPreview / filesToIndex.length) || 50; // Минимум 50 символов
      
      for (const file of filesToIndex) {
        let content = "";
        try {
          content = await this.app.vault.cachedRead(file);
        } catch (e) {
          continue;
        }
        const size = content.length;
        const preview = content.substring(0, previewLengthPerFile) + (content.length > previewLengthPerFile ? "..." : "");
        const cache = this.app.metadataCache.getFileCache(file);
        const tags = cache?.frontmatter?.tags || [];
        const keywords = tags.length > 0 ? `Теги: ${tags.join(", ")}` : "";
        
        indexContent += `📄 [[${file.path.replace(/\.md$/, '')}]]\n`;
        indexContent += `Размер: ${size} символов\n`;
        if (keywords) indexContent += `${keywords}\n`;
        if (previewLengthPerFile > 10) indexContent += `Превью: ${preview}\n`;
        indexContent += `\n`;
        
        // Проверяем, не превысили ли лимит
        if (indexContent.length > maxContextLength - 100) {
          indexContent += "[Индекс обрезан - недостаточно места]\n";
          break;
        }
      }
      
      this.attachedFiles.push({
        name: "Индекс файлов",
        type: "note",
        path: "vault-index",
        content: indexContent,
      });

      // Добавляем индекс как сообщение в чат
      this.addMessageToUI("system", `📋 **Индекс файлов создан**\n\n${indexContent}`);
      this.messages.push({ role: "system", content: `📋 **Индекс файлов создан**\n\n${indexContent}` });
    } else {
      // Обычное добавление с обрезкой
      let totalLength = 0;
      for (const file of textFiles) {
        let content = "";
        try {
          content = await this.app.vault.cachedRead(file);
        } catch (e) {
          continue;
        }
        if (this.attachedFiles.some((f) => f.path === file.path || f.name === file.basename)) {
          continue;
        }

        // Вычисляем, сколько места осталось
        const remainingLength = maxContextLength - totalLength;
        if (remainingLength <= 0) {
          break;
        }

        // Обрезаем контент, если нужно
        let truncatedContent = content;
        if (content.length > remainingLength) {
          truncatedContent = content.substring(0, remainingLength - 100);
          truncatedContent += "\n\n[Текст обрезан для экономии контекста]";
        }

        this.attachedFiles.push({
          name: file.basename,
          type: file.extension === "md" ? "note" : "file",
          path: file.path,
          content: truncatedContent,
        });
        totalLength += truncatedContent.length;
      }
    }

    this.updateAttachmentsUI();
    if (this.attachedFiles.length === 0) {
      new Notice("Не найдено подходящих файлов для добавления. Проверьте настройки фильтров.");
    } else {
      const totalSize = this.attachedFiles.reduce((sum, f) => sum + (f.content?.length || 0), 0);
      new Notice(`✅ Добавлено ${this.attachedFiles.length} файлов (${Math.round(totalSize / 1024)} КБ)`);
    }
  }

  async showConfirmModal(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, title, message, resolve);
      modal.open();
    });
  }

  clearChat() {
    this.messages = [];
    this.attachedFiles = [];
    this.messagesEl.empty();
    this.updateAttachmentsUI();
    this.addMessageToUI("system", "💬 Чат очищен. Прикрепите файлы и задайте вопрос.");
  }

  async saveChatAsNote() {
    if (this.messages.length === 0) {
      new Notice("Чат пустой, нечего сохранять");
      return;
    }

    try {
      // Формируем содержимое заметки
      let content = "# Чат с Doc Summarize\n\n";
      content += `**Дата:** ${new Date().toLocaleString()}\n\n`;
      
      if (this.attachedFiles.length > 0) {
        content += "## Прикреплённые файлы\n\n";
        for (const file of this.attachedFiles) {
          content += `- [[${file.name}]]\n`;
        }
        content += "\n";
      }

      content += "## Сообщения\n\n";

      for (const message of this.messages) {
        if (message.role === "system") {
          content += `**Система:** ${message.content}\n\n`;
        } else if (message.role === "user") {
          content += `**Вы:** ${message.content}\n\n`;
        } else if (message.role === "assistant") {
          content += `**AI:** ${message.content}\n\n`;
        }
      }

      // Создаем новую заметку
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const fileName = `Chat-${timestamp}.md`;
      
      await this.app.vault.create(fileName, content);
      
      new Notice(`Чат сохранён как заметка: ${fileName}`);
    } catch (error) {
      console.error("Ошибка при сохранении чата:", error);
      new Notice("Ошибка при сохранении чата");
    }
  }

  async sendMessage() {
    const question = this.inputEl.value.trim();
    if (!question) return;

    // Сохраняем команду в истории
    this.commandHistory.push(question);
    if (this.commandHistory.length > 50) {
      this.commandHistory.shift(); // Ограничиваем историю 50 командами
    }
    this.historyIndex = -1; // Сбрасываем индекс истории

    this.inputEl.disabled = true;
    this.sendBtn.disabled = true;

    this.addMessageToUI("user", question);
    this.inputEl.value = "";

    // Формируем контекст из прикреплённых файлов
    let context = "";
    const images: string[] = [];
    const textFiles = this.attachedFiles.filter(f => f.type !== "image" && f.content);

    if (this.plugin.settings.useMapReduce && textFiles.length > 0) {
      // Map-Reduce: суммируем каждый документ отдельно
      const summaries: string[] = [];
      for (const file of textFiles) {
        if (file.content) {
          const summary = await this.plugin.getSummary(file.content);
          if (summary) {
            summaries.push(`=== Суммаризация ${file.name} ===\n${summary}`);
          }
        }
      }
      // Объединяем суммаризации, ограничивая общий размер
      const combinedSummaries = summaries.join('\n\n');
      const maxSummariesLength = this.plugin.settings.maxContextLength - question.length - 500; // Резерв для промпта
      if (combinedSummaries.length > maxSummariesLength) {
        context = combinedSummaries.substring(0, maxSummariesLength) + "\n\n[Суммаризации обрезаны для экономии контекста]";
      } else {
        context = combinedSummaries;
      }
    } else {
      // Stuffing: равномерное деление
      const maxContextForDocs = this.plugin.settings.maxContextLength - question.length;
      const charsPerFile = textFiles.length > 0 ? Math.floor(maxContextForDocs / textFiles.length) : 0;

      if (charsPerFile <= 0 && textFiles.length > 0) {
        new Notice(`Слишком много документов (${textFiles.length}) для контекста ${this.plugin.settings.maxContextLength} символов. Уменьшите количество документов или увеличьте лимит контекста.`);
        return;
      }

      for (const file of this.attachedFiles) {
        if (file.type === "image" && file.base64) {
          images.push(`data:${file.mimeType};base64,${file.base64}`);
          context += `\n\n[Изображение: ${file.name}]`;
        } else if (file.content) {
          // Ограничиваем длину текста файла
          const truncatedContent = file.content.length > charsPerFile 
            ? file.content.substring(0, charsPerFile) + "\n\n[Текст обрезан для экономии контекста]"
            : file.content;
          context += `\n\n=== ${file.name} ===\n${truncatedContent}`;
        }
      }
    }

    const loadingEl = this.messagesEl.createDiv({ cls: "doc-summarize-loading" });
    loadingEl.setText("🤔 Думаю...");
    this.scrollToBottom();

    try {
      const systemMessage = context 
        ? `${this.plugin.settings.questionPrompt}\n\nПрикреплённые файлы:${context}`
        : this.plugin.settings.questionPrompt;

      const messages: ChatMessage[] = [
        { role: "system", content: systemMessage },
        ...this.messages.filter((m) => m.role !== "system"),
        { role: "user", content: question, images: images.length > 0 ? images : undefined },
      ];

      // Создаем сообщение assistant заранее для стрима
      const assistantMessageEl = this.messagesEl.createDiv({
        cls: `doc-summarize-message assistant`,
      });
      let currentResponse = "";
      
      // Временно отключаем стрим для отладки
      const response = await this.plugin.sendToLMStudio(messages);
      currentResponse = response;
      const processedContent = currentResponse.replace(
        /\[\[(.*?)\]\]/g,
        '<span class="doc-summarize-note-ref" data-note="$1">$1</span>'
      );
      assistantMessageEl.innerHTML = processedContent;
      
      // Добавляем обработчики кликов для ссылок
      assistantMessageEl.querySelectorAll(".doc-summarize-note-ref").forEach((el) => {
        el.addEventListener("click", () => {
          const noteName = el.getAttribute("data-note");
          if (noteName) {
            this.app.workspace.openLinkText(noteName, "");
          }
        });
      });
      
      loadingEl.remove();
      
      this.messages.push({ role: "user", content: question });
      this.messages.push({ role: "assistant", content: response });
    } catch (error) {
      loadingEl.remove();
      this.addMessageToUI("error", "Ошибка при получении ответа. Проверьте подключение к LM Studio.");
    }

    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    this.inputEl.focus();
  }

  addMessageToUI(role: string, content: string) {
    const messageEl = this.messagesEl.createDiv({
      cls: `doc-summarize-message ${role}`,
    });
    
    // Рендерим markdown для assistant и system сообщений
    let processedContent = content;
    if (role === "assistant" || role === "system") {
      processedContent = this.renderMarkdown(content);
    } else {
      processedContent = content.replace(
        /\[\[(.*?)\]\]/g,
        '<span class="doc-summarize-note-ref" data-note="$1">$1</span>'
      );
    }
    
    messageEl.innerHTML = processedContent;

    // Добавляем кнопку копирования для assistant сообщений
    if (role === "assistant") {
      const copyBtn = messageEl.createEl("button", {
        cls: "doc-summarize-copy-btn",
        attr: { "aria-label": "Копировать сообщение" }
      });
      setIcon(copyBtn, "copy");
      copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(content);
        new Notice("Сообщение скопировано");
      };
    }

    messageEl.querySelectorAll(".doc-summarize-note-ref").forEach((el) => {
      el.addEventListener("click", () => {
        const noteName = el.getAttribute("data-note");
        if (noteName) {
          this.app.workspace.openLinkText(noteName, "");
        }
      });
    });

    this.scrollToBottom();
  }

  // Простой рендерер markdown
  renderMarkdown(text: string): string {
    return text
      // Специальная обработка патентов: **XX1234567A1** -> [[XX1234567A1]]
      .replace(/\*\*([A-Z]{2}\d+[A-Z]\d+)\*\*/g, '[[$1]]')
      // Заголовки с конвертацией жирного текста в ссылки
      .replace(/^### (.*$)/gm, (match, content) => `<h3>${content.replace(/\*\*(.*?)\*\*/g, '[[$1]]')}</h3>`)
      .replace(/^## (.*$)/gm, (match, content) => `<h2>${content.replace(/\*\*(.*?)\*\*/g, '[[$1]]')}</h2>`)
      .replace(/^# (.*$)/gm, (match, content) => `<h1>${content.replace(/\*\*(.*?)\*\*/g, '[[$1]]')}</h1>`)
      // Жирный и курсив (для текста вне заголовков)
      .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Код (сначала многострочный)
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Списки (нумерованные и маркированные)
      .replace(/^\* (.*$)/gm, '<li>$1</li>')
      .replace(/^\d+\. (.*$)/gm, '<li>$1</li>')
      // Цитаты
      .replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>')
      // Горизонтальные линии
      .replace(/^---$/gm, '<hr>')
      .replace(/^___$/gm, '<hr>')
      .replace(/^\*\*\*$/gm, '<hr>')
      // Ссылки на заметки (Obsidian)
      .replace(/\[\[(.*?)\]\]/g, '<span class="doc-summarize-note-ref" data-note="$1">$1</span>');
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async onClose() {
    // Cleanup
  }
}

// ==================== МОДАЛЬНЫЕ ОКНА ВЫБОРА ФАЙЛОВ ====================

class ConfirmModal extends Modal {
  title: string;
  message: string;
  onResult: (result: boolean) => void;

  constructor(app: App, title: string, message: string, onResult: (result: boolean) => void) {
    super(app);
    this.title = title;
    this.message = message;
    this.onResult = onResult;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");
    
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.message, cls: "doc-summarize-confirm-message" });

    const buttonsEl = contentEl.createDiv({ cls: "doc-summarize-confirm-buttons" });
    
    const cancelBtn = buttonsEl.createEl("button", { text: "Отмена" });
    cancelBtn.onclick = () => {
      this.onResult(false);
      this.close();
    };

    const confirmBtn = buttonsEl.createEl("button", { text: "Добавить", cls: "mod-cta" });
    confirmBtn.onclick = () => {
      this.onResult(true);
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

class NoteSelectorModal extends Modal {
  onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");
    contentEl.createEl("h2", { text: "Выберите заметку" });

    const searchInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "Поиск заметок...",
      cls: "doc-summarize-search-input",
    });

    const listEl = contentEl.createDiv({ cls: "doc-summarize-file-list" });
    
    const files = this.app.vault.getMarkdownFiles().sort((a, b) => 
      b.stat.mtime - a.stat.mtime
    );

    const renderFiles = (filter: string = "") => {
      listEl.empty();
      const filtered = filter 
        ? files.filter((f) => f.basename.toLowerCase().includes(filter.toLowerCase()))
        : files.slice(0, 20);

      for (const file of filtered) {
        const item = listEl.createDiv({ cls: "doc-summarize-file-item" });
        setIcon(item.createSpan(), "file-text");
        item.createSpan({ text: ` ${file.basename}` });
        item.onclick = () => {
          this.onChoose(file);
          this.close();
        };
      }
    };

    searchInput.addEventListener("input", () => {
      renderFiles(searchInput.value);
    });

    renderFiles();
    searchInput.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ImageSelectorModal extends Modal {
  plugin: DocSummarizePlugin;
  onChoose: (file: TFile) => void;

  constructor(app: App, plugin: DocSummarizePlugin, onChoose: (file: TFile) => void) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");
    contentEl.createEl("h2", { text: "Выберите изображение" });

    const listEl = contentEl.createDiv({ cls: "doc-summarize-file-list doc-summarize-image-grid" });
    
    const files = this.app.vault.getFiles()
      .filter((f) => this.plugin.isImageFile(f))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 30);

    for (const file of files) {
      const item = listEl.createDiv({ cls: "doc-summarize-image-item" });
      
      // Создаём превью
      const imgContainer = item.createDiv({ cls: "doc-summarize-image-preview-container" });
      const resourcePath = this.app.vault.getResourcePath(file);
      imgContainer.createEl("img", { 
        attr: { src: resourcePath },
        cls: "doc-summarize-image-preview-thumb"
      });
      
      item.createDiv({ text: file.basename, cls: "doc-summarize-image-name" });
      
      item.onclick = () => {
        this.onChoose(file);
        this.close();
      };
    }

    if (files.length === 0) {
      listEl.createDiv({ text: "Нет изображений в vault", cls: "doc-summarize-empty-message" });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FileSelectorModal extends Modal {
  plugin: DocSummarizePlugin;
  onChoose: (file: TFile) => void;

  constructor(app: App, plugin: DocSummarizePlugin, onChoose: (file: TFile) => void) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");
    contentEl.createEl("h2", { text: "Выберите файл" });

    const searchInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "Поиск файлов...",
      cls: "doc-summarize-search-input",
    });

    const listEl = contentEl.createDiv({ cls: "doc-summarize-file-list" });
    
    const files = this.app.vault.getFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);

    const renderFiles = (filter: string = "") => {
      listEl.empty();
      const filtered = filter 
        ? files.filter((f) => f.basename.toLowerCase().includes(filter.toLowerCase()))
        : files.slice(0, 30);

      for (const file of filtered) {
        const item = listEl.createDiv({ cls: "doc-summarize-file-item" });
        
        const icon = this.plugin.isImageFile(file) ? "image" : "file-text";
        setIcon(item.createSpan(), icon);
        item.createSpan({ text: ` ${file.name}` });
        
        item.onclick = () => {
          this.onChoose(file);
          this.close();
        };
      }
    };

    searchInput.addEventListener("input", () => {
      renderFiles(searchInput.value);
    });

    renderFiles();
    searchInput.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ==================== ОСТАЛЬНЫЕ МОДАЛЬНЫЕ ОКНА ====================

// Модальное окно суммаризации
class SummaryModal extends Modal {
  plugin: DocSummarizePlugin;
  content: string;
  title: string;

  constructor(
    app: App,
    plugin: DocSummarizePlugin,
    content: string,
    title: string
  ) {
    super(app);
    this.plugin = plugin;
    this.content = content;
    this.title = title;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");

    contentEl.createEl("h2", { text: `Суммаризация: ${this.title}` });

    const loadingEl = contentEl.createDiv({ cls: "doc-summarize-loading" });
    loadingEl.setText("Генерация суммаризации...");

    try {
      const summary = await this.plugin.getSummary(this.content);
      
      loadingEl.remove();
      
      if (summary) {
        const resultEl = contentEl.createDiv({ cls: "doc-summarize-result" });
        resultEl.innerHTML = this.formatMarkdown(summary);

        const actionsEl = contentEl.createDiv({ cls: "doc-summarize-actions" });
        
        const copyBtn = actionsEl.createEl("button", { text: "📋 Копировать" });
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(summary);
          new Notice("Суммаризация скопирована в буфер обмена");
        };

        const insertBtn = actionsEl.createEl("button", { text: "📝 Вставить в документ" });
        insertBtn.onclick = () => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view) {
            const editor = view.editor;
            const cursor = editor.getCursor();
            editor.replaceRange(
              `\n\n---\n## Суммаризация\n\n${summary}\n\n---\n`,
              cursor
            );
            new Notice("Суммаризация добавлена в документ");
            this.close();
          }
        };
      }
    } catch (error) {
      loadingEl.remove();
      const errorEl = contentEl.createDiv({ cls: "doc-summarize-message error" });
      errorEl.setText("Ошибка при получении суммаризации. Проверьте подключение к LM Studio.");
    }
  }

  formatMarkdown(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/^### (.*$)/gm, "<h3>$1</h3>")
      .replace(/^## (.*$)/gm, "<h2>$1</h2>")
      .replace(/^# (.*$)/gm, "<h1>$1</h1>")
      .replace(/^- (.*$)/gm, "<li>$1</li>")
      .replace(/\n/g, "<br>");
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Модальное окно чата о документе
class ChatModal extends Modal {
  plugin: DocSummarizePlugin;
  content: string;
  file: TFile | null;
  messages: ChatMessage[] = [];
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  attachedFiles: AttachedFile[] = [];
  commandHistory: string[] = [];
  historyIndex: number = -1;

  constructor(
    app: App,
    plugin: DocSummarizePlugin,
    content: string,
    file: TFile | null
  ) {
    super(app);
    this.plugin = plugin;
    this.content = content;
    this.file = file;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");

    // Инициализируем прикрепленные файлы основным документом
    if (this.file) {
      this.attachedFiles = [{
        name: this.file.basename,
        type: "note",
        path: this.file.path,
        content: this.content,
      }];
    }

    contentEl.createEl("h2", { text: `Вопросы о: ${this.file?.basename || "Документ"}` });

    // Кнопка сохранения чата
    const saveBtn = contentEl.createEl("button", { 
      cls: "doc-summarize-save-chat-btn",
      text: "💾 Сохранить чат как заметку"
    });
    saveBtn.onclick = () => this.saveChatAsNote();

    const contextInfo = contentEl.createDiv({ cls: "doc-summarize-context-info" });
    contextInfo.setText(`📄 Контекст: ${this.content.length} символов`);

    let linkedContent = "";
    if (this.plugin.settings.includeLinkedNotes && this.file) {
      const linkedNotes = await this.plugin.getLinkedNotes(
        this.file,
        this.plugin.settings.maxLinkedNotesDepth
      );
      if (linkedNotes.size > 0) {
        linkedContent = "\n\n--- Связанные заметки ---\n\n" + 
          Array.from(linkedNotes.values()).join("\n\n");
        contextInfo.setText(
          `📄 Контекст: ${this.content.length} символов | 🔗 Связанные заметки: ${linkedNotes.size}`
        );
      }
    }

    const fullContext = this.content + linkedContent;

    this.messages = [
      {
        role: "system",
        content: `${this.plugin.settings.questionPrompt}\n\nКонтекст документа:\n\n${fullContext}`,
      },
    ];

    const chatContainer = contentEl.createDiv({ cls: "doc-summarize-chat-container" });
    this.messagesEl = chatContainer.createDiv({ cls: "doc-summarize-messages" });

    const inputArea = chatContainer.createDiv({ cls: "doc-summarize-input-area" });
    
    this.inputEl = inputArea.createEl("textarea", {
      placeholder: "Задайте вопрос о документе...",
    });
    
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      } else if (e.key === "ArrowUp" && this.historyIndex === -1 && this.inputEl.value === "") {
        // Показать последний запрос из истории
        if (this.commandHistory.length > 0) {
          this.historyIndex = this.commandHistory.length - 1;
          this.inputEl.value = this.commandHistory[this.historyIndex];
        }
        e.preventDefault();
      } else if (e.key === "ArrowUp" && this.historyIndex > 0) {
        // Перейти к предыдущему запросу
        this.historyIndex--;
        this.inputEl.value = this.commandHistory[this.historyIndex];
        e.preventDefault();
      } else if (e.key === "ArrowDown" && this.historyIndex >= 0 && this.historyIndex < this.commandHistory.length - 1) {
        // Перейти к следующему запросу
        this.historyIndex++;
        this.inputEl.value = this.commandHistory[this.historyIndex];
        e.preventDefault();
      } else if (e.key === "ArrowDown" && this.historyIndex === this.commandHistory.length - 1) {
        // Вернуться к пустому полю
        this.historyIndex = -1;
        this.inputEl.value = "";
        e.preventDefault();
      }
    });

    this.sendBtn = inputArea.createEl("button", {
      text: "Отправить",
      cls: "doc-summarize-send-btn",
    });
    this.sendBtn.onclick = () => this.sendMessage();

    this.inputEl.focus();
  }

  async sendMessage() {
    const question = this.inputEl.value.trim();
    if (!question) return;

    // Сохраняем команду в истории
    this.commandHistory.push(question);
    if (this.commandHistory.length > 50) {
      this.commandHistory.shift(); // Ограничиваем историю 50 командами
    }
    this.historyIndex = -1; // Сбрасываем индекс истории

    this.inputEl.disabled = true;
    this.sendBtn.disabled = true;

    this.addMessageToUI("user", question);
    this.messages.push({ role: "user", content: question });
    this.inputEl.value = "";

    const loadingEl = this.messagesEl.createDiv({ cls: "doc-summarize-loading" });
    loadingEl.setText("🤔 Думаю...");
    this.scrollToBottom();

    try {
      const response = await this.plugin.sendToLMStudio(this.messages);
      
      loadingEl.remove();
      
      this.addMessageToUI("assistant", response);
      this.messages.push({ role: "assistant", content: response });
    } catch (error) {
      loadingEl.remove();
      this.addMessageToUI("error", "Ошибка при получении ответа. Проверьте подключение к LM Studio.");
    }

    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    this.inputEl.focus();
  }

  async saveChatAsNote() {
    if (this.messages.length === 0) {
      new Notice("Чат пустой, нечего сохранять");
      return;
    }

    try {
      // Формируем содержимое заметки
      let content = "# Чат с Doc Summarize\n\n";
      content += `**Дата:** ${new Date().toLocaleString()}\n\n`;
      content += `**Документ:** [[${this.file?.basename || "Неизвестный документ"}]]\n\n`;

      if (this.attachedFiles.length > 0) {
        content += "## Прикреплённые файлы\n\n";
        for (const file of this.attachedFiles) {
          content += `- [[${file.name}]]\n`;
        }
        content += "\n";
      }

      content += "## Сообщения\n\n";

      for (const message of this.messages) {
        if (message.role === "system") {
          content += `**Система:** ${message.content}\n\n`;
        } else if (message.role === "user") {
          content += `**Вы:** ${message.content}\n\n`;
        } else if (message.role === "assistant") {
          content += `**AI:** ${message.content}\n\n`;
        }
      }

      // Создаем новую заметку
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const fileName = `Chat-${this.file?.basename || "Document"}-${timestamp}.md`;
      
      await this.app.vault.create(fileName, content);
      
      new Notice(`Чат сохранён как заметка: ${fileName}`);
    } catch (error) {
      console.error("Ошибка при сохранении чата:", error);
      new Notice("Ошибка при сохранении чата");
    }
  }

  renderMarkdown(content: string): string {
    // Преобразование патентов в ссылки
    const patentRegex = /\*\*([A-Z]{2}\d+[A-Z]\d+)\*\*/g;
    content = content.replace(patentRegex, (match, patentNumber) => {
      const country = patentNumber.substring(0, 2);
      let url = "";
      switch (country) {
        case "US":
          url = `https://patents.google.com/patent/${patentNumber}`;
          break;
        case "RU":
          url = `https://patents.google.com/patent/${patentNumber}`;
          break;
        case "CN":
          url = `https://patents.google.com/patent/${patentNumber}`;
          break;
        case "JP":
          url = `https://patents.google.com/patent/${patentNumber}`;
          break;
        default:
          return match; // Если страна не распознана, оставить как есть
      }
      return `[${patentNumber}](${url})`;
    });

    return content;
  }

  addMessageToUI(role: string, content: string) {
    const messageEl = this.messagesEl.createDiv({
      cls: `doc-summarize-message ${role}`,
    });
    
    // Применяем markdown рендеринг для всех сообщений, включая system
    let processedContent = this.renderMarkdown(content);
    
    // Обрабатываем ссылки на заметки
    processedContent = processedContent.replace(
      /\[\[(.*?)\]\]/g,
      '<span class="doc-summarize-note-ref" data-note="$1">$1</span>'
    );
    
    messageEl.innerHTML = processedContent;

    messageEl.querySelectorAll(".doc-summarize-note-ref").forEach((el) => {
      el.addEventListener("click", () => {
        const noteName = el.getAttribute("data-note");
        if (noteName) {
          this.app.workspace.openLinkText(noteName, "");
        }
      });
    });

    this.scrollToBottom();
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Модальное окно для работы с изображениями
class ImageSummarizeModal extends Modal {
  plugin: DocSummarizePlugin;

  constructor(app: App, plugin: DocSummarizePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");

    contentEl.createEl("h2", { text: "Описание изображения" });

    const infoEl = contentEl.createDiv({ cls: "doc-summarize-context-info" });
    infoEl.setText("Выберите изображение для анализа. Требуется модель с поддержкой vision (например, LLaVA).");

    const inputContainer = contentEl.createDiv();
    
    const fileInput = inputContainer.createEl("input", {
      type: "file",
      attr: { accept: "image/*" },
    });

    const promptInput = contentEl.createEl("textarea", {
      placeholder: "Опишите, что вы хотите узнать об изображении (необязательно)...",
    });
    promptInput.style.width = "100%";
    promptInput.style.minHeight = "60px";
    promptInput.style.marginTop = "10px";

    const resultEl = contentEl.createDiv({ cls: "doc-summarize-result" });
    resultEl.style.display = "none";

    const analyzeBtn = contentEl.createEl("button", {
      text: "Анализировать изображение",
      cls: "doc-summarize-send-btn",
    });
    analyzeBtn.style.marginTop = "15px";

    analyzeBtn.onclick = async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        new Notice("Выберите изображение");
        return;
      }

      analyzeBtn.disabled = true;
      analyzeBtn.setText("Анализ...");

      try {
        const base64 = await this.fileToBase64(file);
        
        const prompt = promptInput.value.trim() || "Опиши это изображение подробно на русском языке.";
        
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: prompt,
            images: [`data:${file.type};base64,${base64}`],
          },
        ];

        const response = await this.plugin.sendToLMStudio(messages);
        
        resultEl.style.display = "block";
        resultEl.setText(response);
      } catch (error) {
        new Notice("Ошибка при анализе изображения. Убедитесь, что используется модель с поддержкой vision.");
        console.error(error);
      }

      analyzeBtn.disabled = false;
      analyzeBtn.setText("Анализировать изображение");
    };
  }

  fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Модальное окно для вопросов по всему vault
class VaultChatModal extends Modal {
  plugin: DocSummarizePlugin;
  messages: ChatMessage[] = [];
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  relevantNotes: TFile[] = [];

  constructor(app: App, plugin: DocSummarizePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("doc-summarize-modal");

    contentEl.createEl("h2", { text: "Вопросы о заметках" });

    const contextInfo = contentEl.createDiv({ cls: "doc-summarize-context-info" });
    contextInfo.setText("Задайте вопрос, и я найду релевантные заметки для ответа.");

    const chatContainer = contentEl.createDiv({ cls: "doc-summarize-chat-container" });
    this.messagesEl = chatContainer.createDiv({ cls: "doc-summarize-messages" });

    const inputArea = chatContainer.createDiv({ cls: "doc-summarize-input-area" });
    
    this.inputEl = inputArea.createEl("textarea", {
      placeholder: "Задайте вопрос о ваших заметках...",
    });
    
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.sendBtn = inputArea.createEl("button", {
      text: "Отправить",
      cls: "doc-summarize-send-btn",
    });
    this.sendBtn.onclick = () => this.sendMessage();

    this.inputEl.focus();
  }

  async sendMessage() {
    const question = this.inputEl.value.trim();
    if (!question) return;

    this.inputEl.disabled = true;
    this.sendBtn.disabled = true;

    this.addMessageToUI("user", question);
    this.inputEl.value = "";

    const loadingEl = this.messagesEl.createDiv({ cls: "doc-summarize-loading" });
    loadingEl.setText("Поиск релевантных заметок...");
    this.scrollToBottom();

    try {
      this.relevantNotes = await this.plugin.searchNotes(question);
      
      let context = "";
      for (const note of this.relevantNotes) {
        const content = await this.app.vault.cachedRead(note);
        context += `\n\n=== [[${note.path.replace(/\.md$/, '')}]] ===\n${content.substring(0, 2000)}`;
      }

      loadingEl.setText("🤔 Думаю...");

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `${this.plugin.settings.questionPrompt}\n\nРелевантные заметки:${context}`,
        },
        ...this.messages.filter((m) => m.role !== "system"),
        { role: "user", content: question },
      ];

      const response = await this.plugin.sendToLMStudio(messages);
      
      loadingEl.remove();

      if (this.relevantNotes.length > 0) {
        const notesInfo = `📚 Найденные заметки: ${this.relevantNotes.map((n) => `[[${n.basename}]]`).join(", ")}`;
        this.addMessageToUI("system", notesInfo);
      }

      this.addMessageToUI("assistant", response);
      this.messages.push({ role: "user", content: question });
      this.messages.push({ role: "assistant", content: response });
    } catch (error) {
      loadingEl.remove();
      this.addMessageToUI("error", "Ошибка при получении ответа. Проверьте подключение к LM Studio.");
    }

    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    this.inputEl.focus();
  }

  addMessageToUI(role: string, content: string) {
    const messageEl = this.messagesEl.createDiv({
      cls: `doc-summarize-message ${role}`,
    });
    
    const processedContent = content.replace(
      /\[\[(.*?)\]\]/g,
      '<span class="doc-summarize-note-ref" data-note="$1">$1</span>'
    );
    
    messageEl.innerHTML = processedContent;

    messageEl.querySelectorAll(".doc-summarize-note-ref").forEach((el) => {
      el.addEventListener("click", () => {
        const noteName = el.getAttribute("data-note");
        if (noteName) {
          this.app.workspace.openLinkText(noteName, "");
        }
      });
    });

    this.scrollToBottom();
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ==================== НАСТРОЙКИ ====================

class DocSummarizeSettingTab extends PluginSettingTab {
  plugin: DocSummarizePlugin;
  modelDropdown: HTMLSelectElement | null = null;

  constructor(app: App, plugin: DocSummarizePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("doc-summarize-settings");

    containerEl.createEl("h1", { text: "Doc Summarize - Настройки" });

    // Секция подключения
    containerEl.createEl("h2", { text: "Подключение к LM Studio" });

    containerEl.createEl("hr");

    new Setting(containerEl)
      .setName("URL LM Studio API")
      .setDesc("Адрес API LM Studio (обычно http://localhost:1234/v1)")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:1234/v1")
          .setValue(this.plugin.settings.lmStudioUrl)
          .onChange(async (value) => {
            this.plugin.settings.lmStudioUrl = value;
            await this.plugin.saveSettings();
          })
      );


    // Секция выбора модели
    containerEl.createEl("h2", { text: "Модель LM Studio" });
    const modelSetting = new Setting(containerEl)
      .setName("Модель")
      .setDesc("Выберите модель из списка доступных в LM Studio");

    const modelContainer = modelSetting.controlEl.createDiv({ cls: "doc-summarize-model-container" });
    this.modelDropdown = modelContainer.createEl("select", { cls: "doc-summarize-model-select" });
    const refreshBtn = modelContainer.createEl("button", { text: "🔄", cls: "doc-summarize-refresh-btn" });
    refreshBtn.setAttribute("aria-label", "Обновить список моделей");
    refreshBtn.onclick = async () => {
      await this.refreshModels();
    };
    await this.refreshModels();

    containerEl.createEl("hr");

    // Секция контекста
    containerEl.createEl("h2", { text: "Контекст и токены" });

    new Setting(containerEl)
      .setName("Максимальная длина контекста")
      .setDesc("Максимальное количество символов в контексте для чата (включая запрос пользователя и документы)")
      .addText((text) =>
        text
          .setPlaceholder("4000")
          .setValue(this.plugin.settings.maxContextLength.toString())
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxContextLength = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Использовать Map-Reduce для документов")
      .setDesc("Если включено, каждый документ будет сначала суммирован отдельно, затем суммаризации объединятся в контекст (лучше для большого количества документов)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useMapReduce)
          .onChange(async (value) => {
            this.plugin.settings.useMapReduce = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Максимальное количество токенов")
      .setDesc("Максимальное количество токенов для генерации ответа")
      .addText((text) =>
        text
          .setPlaceholder("2048")
          .setValue(this.plugin.settings.maxTokens.toString())
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxTokens = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Температура")
      .setDesc("Креативность ответа (0.0 - детерминированный, 1.0 - креативный)")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.1)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.temperature = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Фильтр по тегам")
      .setDesc("Теги для фильтрации файлов при выборе 'Все файлы' (через запятую). Если пусто — все файлы.")
      .addText((text) =>
        text
          .setPlaceholder("important, recent")
          .setValue(this.plugin.settings.includeTags?.join(", ") || "")
          .onChange(async (value) => {
            const tags = value.split(",").map(t => t.trim()).filter(Boolean);
            this.plugin.settings.includeTags = tags.length > 0 ? tags : undefined;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Максимальный возраст файлов (дни)")
      .setDesc("Максимальный возраст файлов в днях (0 — все файлы)")
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(this.plugin.settings.maxFileAge?.toString() || "0")
          .onChange(async (value) => {
            const days = parseInt(value);
            if (!isNaN(days) && days >= 0) {
              this.plugin.settings.maxFileAge = days;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Использовать индекс файлов")
      .setDesc("Вместо полного контента добавлять индекс файлов (имена, размеры, ключевые слова) для работы со всеми файлами vault")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useFileIndex)
          .onChange(async (value) => {
            this.plugin.settings.useFileIndex = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Максимум файлов в индексе")
      .setDesc("Максимальное количество файлов для включения в индекс (0 - все)")
      .addText((text) =>
        text
          .setPlaceholder("50")
          .setValue(this.plugin.settings.maxIndexFiles?.toString() || "50")
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.maxIndexFiles = num;
              await this.plugin.saveSettings();
            }
          })
      );

    containerEl.createEl("hr");

    // Секция выбора папок
    containerEl.createEl("h2", { text: "Рабочие папки" });
    new Setting(containerEl)
      .setName("Папки для работы")
      .setDesc("Выберите папки, которые будут использоваться для суммаризации и поиска. Если не выбрано — используются все.")
      .addButton((btn) => {
        btn.setButtonText("Выбрать папки");
        btn.onClick(async () => {
          const folders = this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder)
            .map(f => f.path);
          const modal = new FolderSelectModal(this.app, this.plugin.settings.includeFolders || [], folders, async (selected) => {
            this.plugin.settings.includeFolders = selected;
            await this.plugin.saveSettings();
            this.display();
          });
          modal.open();
        });
      })
      .setDesc("Текущие: " + (this.plugin.settings.includeFolders?.length ? this.plugin.settings.includeFolders.join(", ") : "все папки"));

    containerEl.createEl("hr");
// Модальное окно выбора папок
class FolderSelectModal extends Modal {
  selected: string[];
  allFolders: string[];
  onChoose: (selected: string[]) => void;

  constructor(app: App, selected: string[], allFolders: string[], onChoose: (selected: string[]) => void) {
    super(app);
    this.selected = [...selected];
    this.allFolders = allFolders;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Выберите папки" });
    const list = contentEl.createDiv();
    this.allFolders.forEach(folder => {
      const item = list.createDiv();
      const checkbox = item.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selected.includes(folder);
      checkbox.onchange = () => {
        if (checkbox.checked) {
          this.selected.push(folder);
        } else {
          this.selected = this.selected.filter(f => f !== folder);
        }
      };
      item.createSpan({ text: folder });
    });
    const actions = contentEl.createDiv();
    const okBtn = actions.createEl("button", { text: "OK" });
    okBtn.onclick = () => {
      this.onChoose(this.selected);
      this.close();
    };
    const cancelBtn = actions.createEl("button", { text: "Отмена" });
    cancelBtn.onclick = () => this.close();
  }
}

    // Кнопка проверки подключения
    new Setting(containerEl)
      .setName("Проверить подключение")
      .setDesc("Проверить соединение с LM Studio и обновить список моделей")
      .addButton((btn) =>
        btn.setButtonText("Проверить").onClick(async () => {
          const connected = await this.plugin.checkConnection();
          if (connected) {
            await this.refreshModels();
            new Notice(`✅ Подключено! Найдено моделей: ${this.plugin.availableModels.length}`);
          } else {
            new Notice("❌ Не удалось подключиться к LM Studio");
          }
        })
      );

    // Секция промптов
    containerEl.createEl("h2", { text: "Промпты" });

    new Setting(containerEl)
      .setName("Промпт для суммаризации")
      .setDesc("Системный промпт для суммаризации документов")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.summarizePrompt)
          .onChange(async (value) => {
            this.plugin.settings.summarizePrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 50;
      });

    new Setting(containerEl)
      .setName("Промпт для вопросов")
      .setDesc("Системный промпт для ответов на вопросы")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.questionPrompt)
          .onChange(async (value) => {
            this.plugin.settings.questionPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 50;
      });

    // Секция связанных заметок
    containerEl.createEl("h2", { text: "Связанные заметки" });

    new Setting(containerEl)
      .setName("Включать связанные заметки")
      .setDesc("Автоматически добавлять содержимое связанных заметок в контекст")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeLinkedNotes)
          .onChange(async (value) => {
            this.plugin.settings.includeLinkedNotes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Глубина связей")
      .setDesc("Насколько глубоко искать связанные заметки (1-3)")
      .addSlider((slider) =>
        slider
          .setLimits(1, 3, 1)
          .setValue(this.plugin.settings.maxLinkedNotesDepth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxLinkedNotesDepth = value;
            await this.plugin.saveSettings();
          })
      );
  }

  async refreshModels() {
    if (!this.modelDropdown) return;

    this.modelDropdown.empty();
    
    const loadingOption = this.modelDropdown.createEl("option", { 
      text: "Загрузка...", 
      value: "" 
    });

    const models = await this.plugin.loadAvailableModels();

    this.modelDropdown.empty();

    if (models.length === 0) {
      this.modelDropdown.createEl("option", { 
        text: "Модели не найдены", 
        value: "" 
      });
      return;
    }

    for (const model of models) {
      const option = this.modelDropdown.createEl("option", {
        text: model.id,
        value: model.id,
      });
      if (model.id === this.plugin.settings.model) {
        option.selected = true;
      }
    }

    this.modelDropdown.onchange = async () => {
      this.plugin.settings.model = this.modelDropdown!.value;
      await this.plugin.saveSettings();
      new Notice(`Выбрана модель: ${this.plugin.settings.model}`);
    };
  }
}

// Модальное окно выбора папки
class FolderSelectorModal extends Modal {
  onChoose: (folderPath: string) => void;

  constructor(app: App, onChoose: (folderPath: string) => void) {
    super(app);
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Выберите папку" });
    
    const folders = this.app.vault.getAllLoadedFiles()
      .filter(f => f instanceof TFolder)
      .map(f => f.path)
      .sort();
    
    const list = contentEl.createDiv({ cls: "doc-summarize-folder-list" });
    
    folders.forEach(folder => {
      const item = list.createDiv({ cls: "doc-summarize-folder-item" });
      setIcon(item.createSpan({ cls: "doc-summarize-folder-icon" }), "folder");
      item.createSpan({ text: folder, cls: "doc-summarize-folder-name" });
      item.onclick = () => {
        this.onChoose(folder);
        this.close();
      };
    });
  }
}
