import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  webExt: { disabled: true },
  vite: () => ({
    build: { modulePreload: false },
    plugins:[{name:'modern-twitter-text',enforce:'pre',transform(code,id){
      // Retain the official counter, omit only obsolete global core-js patches.
      // MV3 targets Chromium >=120; those ES features are already native.
      if(id.includes('/node_modules/twitter-text/dist/esm/'))return {code:code.replace(/^import ["']core-js\/[^"']+["'];\s*$/gm,''),map:null};
    }}],
  }),
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // Runtime content scripts are injected only after an explicit optional grant.
      delete manifest.host_permissions;
    },
  },
  manifest: {
    name: '灵同步',
    description: '本地编辑动态、视频和文章，按平台填写、存稿或直接发布。',
    version: '0.2.14',
    version_name: '0.2.14-dev.6',
    minimum_chrome_version: '120',
    permissions: ['storage', 'scripting', 'sidePanel', 'alarms'],
    optional_host_permissions: ['https://mp.weixin.qq.com/*', 'https://wx.zsxq.com/*','https://web.okjike.com/*','https://creator.douyin.com/*','https://cp.kuaishou.com/*','https://channels.weixin.qq.com/*','https://member.bilibili.com/*','https://x.com/*','https://creator.xiaohongshu.com/*','https://t.bilibili.com/*'],
    action: { default_title: '打开灵同步' },
    icons: { 16: '/icon-16.png', 32: '/icon-32.png', 48: '/icon-48.png', 128: '/icon-128.png' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
  },
});
