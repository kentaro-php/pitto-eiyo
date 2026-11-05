/* ピッと栄養 フロント設定（デプロイ先ごとに書き換える） */
window.PITTO_CONFIG = {
  /* GAS Web App の URL（デプロイ後に表示される https://script.google.com/macros/s/.../exec） */
  apiUrl: 'https://script.google.com/macros/s/AKfycbxxeVEy6ixqorZ1ik0P4b07Yt_IkWNW1zK2yz3G0FAcFw5c-NnZRt2HHBMS65h0M8Zl/exec',
  /* Google Cloud の OAuth 2.0 クライアントID（ウェブ アプリケーション）。
   * 空のままだと「開発モード」になり、ログイン無しで devToken を送る（GAS 側も AUTH_MODE=dev にする） */
  googleClientId: '',
  devToken: 'dev',
  appName: 'ピッと栄養',
  version: '1.0.0',
  /* 起動時に取り込む直近日数（記録のローカルキャッシュ） */
  syncDays: 35
};
