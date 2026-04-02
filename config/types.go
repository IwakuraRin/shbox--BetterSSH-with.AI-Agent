package config

type LinuxServer struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// ChatMsg is one persisted bubble in the per-model conversation.
type ChatMsg struct {
	ID   string `json:"id"`
	Role string `json:"role"` // user | assistant
	Text string `json:"text"`
}

type AIModel struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	APIKey       string    `json:"apiKey"`
	BaseURL      string    `json:"baseURL"`
	SystemPrompt string    `json:"systemPrompt"`
	HistoryLimit int       `json:"historyLimit"` // 0 = use app default (20)
	ChatMessages []ChatMsg `json:"chatMessages"`
}

type AppState struct {
	Servers         []LinuxServer `json:"servers"`
	AIModels        []AIModel     `json:"aiModels"`
	ActiveAIModelID string        `json:"activeAiModelId"`
}

