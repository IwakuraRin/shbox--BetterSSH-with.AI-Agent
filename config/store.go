package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const appFolderName = "shbox-software"

type Store struct {
	path          string
	machineSecret string
}

func NewStore(machineSecret string) (*Store, error) {
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("user config dir: %w", err)
	}
	dir := filepath.Join(cfgDir, appFolderName, "config")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir config dir: %w", err)
	}
	return &Store{
		path:          filepath.Join(dir, "appstate.enc"),
		machineSecret: machineSecret,
	}, nil
}

func (s *Store) Load() (*AppState, error) {
	blob, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &AppState{}, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}
	plain, err := decrypt(s.machineSecret, blob)
	if err != nil {
		return nil, err
	}
	var st AppState
	if err := json.Unmarshal(plain, &st); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	return &st, nil
}

func (s *Store) Save(state *AppState) error {
	if state == nil {
		state = &AppState{}
	}
	plain, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	blob, err := encrypt(s.machineSecret, plain)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return fmt.Errorf("write tmp config: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

func (s *Store) Path() string { return s.path }

