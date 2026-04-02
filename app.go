package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"shbox-software/config"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/crypto/ssh"
)

// App struct
type App struct {
	ctx        context.Context
	mu         sync.Mutex
	sshClient  *ssh.Client
	sshSession *ssh.Session
	sshStdin   io.WriteCloser
	sshAddress string
	sshUser    string

	cfgMu sync.Mutex
	store *config.Store
	state *config.AppState

	aiMu       sync.Mutex
	aiCancels  map[string]context.CancelFunc
	httpClient *http.Client
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.httpClient = &http.Client{Timeout: 0}
	a.aiCancels = make(map[string]context.CancelFunc)

	hostname, _ := os.Hostname()
	home, _ := os.UserHomeDir()
	machineSecret := fmt.Sprintf("%s|%s|%s", "shbox-software", hostname, home)

	store, err := config.NewStore(machineSecret)
	if err != nil {
		runtime.LogErrorf(a.ctx, "config init failed: %v", err)
		return
	}
	st, err := store.Load()
	if err != nil {
		runtime.LogErrorf(a.ctx, "config load failed: %v", err)
		st = &config.AppState{}
	}
	a.cfgMu.Lock()
	a.store = store
	a.state = st
	a.cfgMu.Unlock()
}

// GetAppState returns persisted servers + AI models + active model ID.
func (a *App) GetAppState() (*config.AppState, error) {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if a.state == nil {
		a.state = &config.AppState{}
	}
	// return a copy to keep internal state safe-ish
	cp := *a.state
	cp.Servers = append([]config.LinuxServer(nil), a.state.Servers...)
	cp.AIModels = make([]config.AIModel, len(a.state.AIModels))
	for i := range a.state.AIModels {
		m := a.state.AIModels[i]
		m.ChatMessages = append([]config.ChatMsg(nil), m.ChatMessages...)
		cp.AIModels[i] = m
	}
	return &cp, nil
}

func (a *App) SaveServers(servers []config.LinuxServer) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if a.state == nil {
		a.state = &config.AppState{}
	}
	a.state.Servers = append([]config.LinuxServer(nil), servers...)
	if a.store == nil {
		return fmt.Errorf("config store not initialized")
	}
	return a.store.Save(a.state)
}

func (a *App) UpsertAIModel(name, apiKey string) (*config.AIModel, error) {
	return a.UpsertAIModelV2(name, apiKey, "")
}

func (a *App) UpsertAIModelV2(name, apiKey, baseURL string) (*config.AIModel, error) {
	return a.UpsertAIModelV3(name, apiKey, baseURL, "", 0)
}

// UpsertAIModelV3 upserts by model name; preserves per-model chat when updating the same profile.
func (a *App) UpsertAIModelV3(name, apiKey, baseURL, systemPrompt string, historyLimit int) (*config.AIModel, error) {
	trimName := strings.TrimSpace(name)
	trimKey := strings.TrimSpace(apiKey)
	if trimName == "" {
		return nil, fmt.Errorf("model name is required")
	}
	trimBase := strings.TrimSpace(baseURL)
	trimSys := strings.TrimSpace(systemPrompt)
	// apiKey can be empty for local providers (e.g. Ollama)
	if historyLimit < 0 {
		historyLimit = 0
	}
	if historyLimit > 200 {
		historyLimit = 200
	}

	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if a.state == nil {
		a.state = &config.AppState{}
	}
	if a.store == nil {
		return nil, fmt.Errorf("config store not initialized")
	}

	// upsert by name
	for i := range a.state.AIModels {
		if strings.EqualFold(a.state.AIModels[i].Name, trimName) {
			a.state.AIModels[i].APIKey = trimKey
			a.state.AIModels[i].BaseURL = trimBase
			a.state.AIModels[i].SystemPrompt = trimSys
			a.state.AIModels[i].HistoryLimit = historyLimit
			a.state.ActiveAIModelID = a.state.AIModels[i].ID
			if err := a.store.Save(a.state); err != nil {
				return nil, err
			}
			model := a.state.AIModels[i]
			return &model, nil
		}
	}

	model := config.AIModel{
		ID:           fmt.Sprintf("mdl-%d", time.Now().UnixNano()),
		Name:         trimName,
		APIKey:       trimKey,
		BaseURL:      trimBase,
		SystemPrompt: trimSys,
		HistoryLimit: historyLimit,
		ChatMessages: nil,
	}
	a.state.AIModels = append([]config.AIModel{model}, a.state.AIModels...)
	a.state.ActiveAIModelID = model.ID

	if err := a.store.Save(a.state); err != nil {
		return nil, err
	}
	return &model, nil
}

// SaveChatForModel persists the in-memory chat transcript for one model (per-model isolation).
func (a *App) SaveChatForModel(modelID string, messages []config.ChatMsg) error {
	id := strings.TrimSpace(modelID)
	if id == "" {
		return fmt.Errorf("model id is empty")
	}
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if a.state == nil {
		a.state = &config.AppState{}
	}
	if a.store == nil {
		return fmt.Errorf("config store not initialized")
	}
	for i := range a.state.AIModels {
		if a.state.AIModels[i].ID == id {
			a.state.AIModels[i].ChatMessages = append([]config.ChatMsg(nil), messages...)
			return a.store.Save(a.state)
		}
	}
	return fmt.Errorf("model not found")
}

func (a *App) SetActiveAIModel(id string) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if a.state == nil {
		a.state = &config.AppState{}
	}
	if a.store == nil {
		return fmt.Errorf("config store not initialized")
	}
	a.state.ActiveAIModelID = strings.TrimSpace(id)
	return a.store.Save(a.state)
}

type aiChunkEvent struct {
	ID    string `json:"id"`
	Chunk string `json:"chunk"`
}

type aiDoneEvent struct {
	ID string `json:"id"`
}

type aiErrorEvent struct {
	ID      string `json:"id"`
	Message string `json:"message"`
}

func (a *App) getActiveAIModelLocked() (*config.AIModel, error) {
	if a.state == nil {
		a.state = &config.AppState{}
	}
	activeID := strings.TrimSpace(a.state.ActiveAIModelID)
	if activeID == "" {
		if len(a.state.AIModels) == 0 {
			return nil, fmt.Errorf("no AI model configured")
		}
		// fallback to first
		m := a.state.AIModels[0]
		a.state.ActiveAIModelID = m.ID
		_ = a.store.Save(a.state)
		return &m, nil
	}
	for i := range a.state.AIModels {
		if a.state.AIModels[i].ID == activeID {
			m := a.state.AIModels[i]
			return &m, nil
		}
	}
	return nil, fmt.Errorf("active AI model not found")
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// StartAIChat starts a cancelable streaming ChatCompletions request.
// Compatible with OpenAI-compatible endpoints (OpenAI/DeepSeek/Ollama/etc.).
// Frontend should listen to events: ai:chunk, ai:done, ai:error.
func (a *App) StartAIChat(messages []ChatMessage) (string, error) {
	if len(messages) == 0 {
		return "", fmt.Errorf("messages is empty")
	}
	for i := range messages {
		messages[i].Role = strings.TrimSpace(messages[i].Role)
		messages[i].Content = strings.TrimSpace(messages[i].Content)
		if messages[i].Role == "" || messages[i].Content == "" {
			return "", fmt.Errorf("message %d is invalid", i)
		}
		switch messages[i].Role {
		case "system", "user", "assistant":
		default:
			return "", fmt.Errorf("message %d: role must be system, user, or assistant", i)
		}
	}

	a.cfgMu.Lock()
	if a.store == nil {
		a.cfgMu.Unlock()
		return "", fmt.Errorf("config store not initialized")
	}
	model, err := a.getActiveAIModelLocked()
	a.cfgMu.Unlock()
	if err != nil {
		return "", err
	}

	reqID := fmt.Sprintf("air-%d", time.Now().UnixNano())

	ctx, cancel := context.WithCancel(context.Background())
	a.aiMu.Lock()
	a.aiCancels[reqID] = cancel
	a.aiMu.Unlock()

	go a.streamChatCompletions(ctx, reqID, model, messages)
	return reqID, nil
}

func (a *App) CancelAIChat(id string) error {
	reqID := strings.TrimSpace(id)
	if reqID == "" {
		return fmt.Errorf("id is empty")
	}
	a.aiMu.Lock()
	cancel, ok := a.aiCancels[reqID]
	if ok {
		delete(a.aiCancels, reqID)
	}
	a.aiMu.Unlock()
	if !ok {
		return fmt.Errorf("request not found")
	}
	cancel()
	return nil
}

func (a *App) finishAIRequest(reqID string) {
	a.aiMu.Lock()
	if cancel, ok := a.aiCancels[reqID]; ok {
		delete(a.aiCancels, reqID)
		// do not call cancel here; stream goroutine will already be done/canceled
		_ = cancel
	}
	a.aiMu.Unlock()
}

func (a *App) streamChatCompletions(ctx context.Context, reqID string, model *config.AIModel, messages []ChatMessage) {
	defer a.finishAIRequest(reqID)

	base := strings.TrimSpace(model.BaseURL)
	if base == "" {
		base = "https://api.openai.com"
	}
	base = strings.TrimRight(base, "/")
	url := base + "/v1/chat/completions"

	payload := map[string]any{
		"model":       model.Name,
		"messages":    messages,
		"stream":      true,
		"temperature": 0.2,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: err.Error()})
		return
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(string(body)))
	if err != nil {
		runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: err.Error()})
		return
	}
	if strings.TrimSpace(model.APIKey) != "" {
		req.Header.Set("Authorization", "Bearer "+model.APIKey)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		if errorsIsContextCanceled(err) {
			runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: "cancelled"})
			return
		}
		runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		msg := strings.TrimSpace(string(b))
		if msg == "" {
			msg = resp.Status
		}
		runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: msg})
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	// SSE lines can be long; bump buffer.
	buf := make([]byte, 0, 1024*64)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		if ctx.Err() != nil {
			runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: "cancelled"})
			return
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
		if data == "[DONE]" {
			runtime.EventsEmit(a.ctx, "ai:done", aiDoneEvent{ID: reqID})
			return
		}

		var obj struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &obj); err != nil {
			continue
		}
		if obj.Error != nil && strings.TrimSpace(obj.Error.Message) != "" {
			runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: obj.Error.Message})
			return
		}
		if len(obj.Choices) > 0 {
			delta := obj.Choices[0].Delta.Content
			if delta != "" {
				runtime.EventsEmit(a.ctx, "ai:chunk", aiChunkEvent{ID: reqID, Chunk: delta})
			}
		}
	}

	if err := scanner.Err(); err != nil {
		if errorsIsContextCanceled(err) {
			runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: "cancelled"})
			return
		}
		runtime.EventsEmit(a.ctx, "ai:error", aiErrorEvent{ID: reqID, Message: err.Error()})
		return
	}
	runtime.EventsEmit(a.ctx, "ai:done", aiDoneEvent{ID: reqID})
}

func errorsIsContextCanceled(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	// net/http wraps context cancellation
	if strings.Contains(err.Error(), "context canceled") {
		return true
	}
	return false
}

// ConnectSSH connects to a Linux server over SSH.
func (a *App) ConnectSSH(host string, port int, username, password string) (string, error) {
	trimmedHost := strings.TrimSpace(host)
	trimmedUser := strings.TrimSpace(username)
	if trimmedHost == "" || trimmedUser == "" {
		return "", fmt.Errorf("host and username are required")
	}
	if port <= 0 {
		port = 22
	}

	config := &ssh.ClientConfig{
		User:            trimmedUser,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", trimmedHost, port)
	client, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return "", fmt.Errorf("failed to connect to %s: %w", addr, err)
	}

	session, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		return "", fmt.Errorf("failed to create SSH session: %w", err)
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}

	if err := session.RequestPty("xterm-256color", 40, 120, modes); err != nil {
		_ = session.Close()
		_ = client.Close()
		return "", fmt.Errorf("failed to request PTY: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return "", fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return "", fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := session.StderrPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return "", fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := session.Shell(); err != nil {
		_ = session.Close()
		_ = client.Close()
		return "", fmt.Errorf("failed to start interactive shell: %w", err)
	}

	a.mu.Lock()
	a.closeSSHLocked()
	a.sshClient = client
	a.sshSession = session
	a.sshStdin = stdin
	a.sshAddress = addr
	a.sshUser = trimmedUser
	a.mu.Unlock()

	go a.streamSSH(stdout)
	go a.streamSSH(stderr)
	go a.waitForSessionExit(session)

	return fmt.Sprintf("Connected to %s as %s", addr, trimmedUser), nil
}

// SendSSHInput writes user input to the active PTY session.
func (a *App) SendSSHInput(input string) error {
	a.mu.Lock()
	stdin := a.sshStdin
	a.mu.Unlock()

	if stdin == nil {
		return fmt.Errorf("not connected")
	}

	if input == "" {
		return nil
	}

	if _, err := io.WriteString(stdin, input); err != nil {
		return fmt.Errorf("failed to send input: %w", err)
	}

	return nil
}

// DisconnectSSH closes the active SSH connection.
func (a *App) DisconnectSSH() string {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.closeSSHLocked()

	return "Disconnected"
}

// GetConnectionLabel returns the current connection label for UI display.
func (a *App) GetConnectionLabel() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sshClient == nil {
		return "Not connected"
	}
	return fmt.Sprintf("%s@%s", a.sshUser, a.sshAddress)
}

func (a *App) closeSSHLocked() {
	if a.sshSession != nil {
		_ = a.sshSession.Close()
		a.sshSession = nil
	}
	if a.sshClient != nil {
		_ = a.sshClient.Close()
		a.sshClient = nil
	}
	a.sshStdin = nil
	a.sshAddress = ""
	a.sshUser = ""
}

func (a *App) streamSSH(reader io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			runtime.EventsEmit(a.ctx, "ssh:output", string(buf[:n]))
		}
		if err != nil {
			if err != io.EOF {
				runtime.EventsEmit(a.ctx, "ssh:error", err.Error())
			}
			return
		}
	}
}

func (a *App) waitForSessionExit(session *ssh.Session) {
	err := session.Wait()

	a.mu.Lock()
	sameSession := a.sshSession == session
	if sameSession {
		a.closeSSHLocked()
	}
	a.mu.Unlock()

	if err != nil {
		runtime.EventsEmit(a.ctx, "ssh:status", fmt.Sprintf("[session closed] %v\r\n", err))
		return
	}
	runtime.EventsEmit(a.ctx, "ssh:status", "[session closed]\r\n")
}
