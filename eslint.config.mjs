import tsparser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
  {
    ignores: ['main.js', 'node_modules/**', 'release/**'],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 删除行为必须尊重用户的系统废纸篓 / Obsidian 回收站设置。
      'obsidianmd/prefer-file-manager-trash-file': 'error',
      // 插件界面以中文为主，且 AI、Vault、Skill、CRM、AppID 等是必须保留
      // 大小写的产品名/技术名。英文 sentence-case 自动修复会破坏这些文案。
      'obsidianmd/ui/sentence-case': 'off',
    },
  },
  {
    files: ['src/main.ts'],
    rules: {
      // 0.7.x 仍支持 Obsidian 1.11.4；声明式设置 API 从 1.13 才存在。
      // 升高 minAppVersion 前保留完整命令式设置页，避免旧版直接失去设置入口。
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
])
