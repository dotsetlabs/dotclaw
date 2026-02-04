import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'DotClaw',
  description: 'Personal OpenRouter-based assistant for Telegram with container isolation, memory, and scheduling.',
  lang: 'en-US',
  base: '/dotclaw/',
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Getting Started', link: '/getting-started/quickstart' },
      { text: 'Configuration', link: '/configuration/' },
      { text: 'Operations', link: '/operations/' },
      { text: 'Deployment', link: '/deployment/systemd' },
      { text: 'Development', link: '/development' }
    ],
    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Requirements', link: '/getting-started/requirements' },
            { text: 'Quickstart', link: '/getting-started/quickstart' },
            { text: 'Manual Setup', link: '/getting-started/manual-setup' }
          ]
        }
      ],
      '/configuration/': [
        {
          text: 'Configuration',
          items: [
            { text: 'Overview', link: '/configuration/' },
            { text: 'Environment (.env)', link: '/configuration/env' },
            { text: 'Runtime Config', link: '/configuration/runtime' },
            { text: 'Model Selection', link: '/configuration/model' },
            { text: 'Behavior Config', link: '/configuration/behavior' },
            { text: 'Tools, Budgets, Plugins', link: '/configuration/tools' }
          ]
        }
      ],
      '/operations/': [
        {
          text: 'Operations',
          items: [
            { text: 'Running DotClaw', link: '/operations/' },
            { text: 'Admin Commands', link: '/operations/admin-commands' },
            { text: 'Containers', link: '/operations/containers' },
            { text: 'Scheduler', link: '/operations/scheduler' },
            { text: 'Memory', link: '/operations/memory' },
            { text: 'Autotune', link: '/operations/autotune' }
          ]
        }
      ],
      '/deployment/': [
        {
          text: 'Deployment',
          items: [
            { text: 'systemd (Linux)', link: '/deployment/systemd' },
            { text: 'launchd (macOS)', link: '/deployment/launchd' }
          ]
        }
      ],
      '/': [
        {
          text: 'Overview',
          items: [
            { text: 'What is DotClaw', link: '/' },
            { text: 'Concepts', link: '/concepts' },
            { text: 'Architecture', link: '/architecture' },
            { text: 'Troubleshooting', link: '/troubleshooting' },
            { text: 'Development', link: '/development' }
          ]
        }
      ]
    },
    outline: 'deep'
  }
});
