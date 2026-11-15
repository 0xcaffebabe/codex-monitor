import { BellRing, Send } from 'lucide-react';
import type { NotificationDelivery } from '../../types';
import { useNotifications } from './useNotifications';

function deliveryStatus(delivery: NotificationDelivery) {
  if (delivery.status === 'pending') return delivery.attempts ? '等待重试' : '等待发送';
  return { sending: '发送中', sent: '已发送', failed: '发送失败', cancelled: '已取消' }[
    delivery.status
  ];
}

export function Notifications({ notify }: { notify: (message: string) => void }) {
  const form = useNotifications(notify);
  return (
    <section className="notification-settings" aria-labelledby="notification-title">
      <h3 id="notification-title">
        <BellRing size={16} />
        Webhook 通知<span>飞书 / Lark</span>
      </h3>
      <p className="help">
        所有工作空间共用此配置，由服务端统一推送。主会话每轮成功完成，或需要你选择、回答时通知。关闭网页后仍会推送；Server
        和 Client 需保持运行。启用时不补发历史通知，子代理不推送。
      </p>
      {form.error && (
        <div className="alert error" role="alert">
          {form.error}
        </div>
      )}
      {form.saved?.monitorError && (
        <div className="alert error" role="alert">
          {form.saved.monitorError}
        </div>
      )}
      {!form.saved && !form.error && (
        <p className="help" role="status">
          正在加载通知配置…
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.save();
        }}
      >
        <fieldset className="notification-fields" disabled={!form.saved || !!form.pending}>
          <label className="notification-toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => form.setEnabled(event.target.checked)}
            />
            启用 Webhook 通知
          </label>
          <label>
            飞书 / Lark Webhook
            <input
              type="password"
              autoComplete="new-password"
              maxLength={512}
              value={form.webhookUrl}
              placeholder={
                form.saved?.webhookConfigured
                  ? '已配置，留空保留；填写新地址可替换'
                  : 'https://open.larksuite.com/open-apis/bot/v2/hook/…'
              }
              onChange={(event) => form.setWebhookUrl(event.target.value)}
            />
          </label>
          {form.saved?.webhookHint && (
            <p className="help notification-hint">当前地址：{form.saved.webhookHint}</p>
          )}
          <label>
            签名密钥（可选）
            <input
              type="password"
              autoComplete="new-password"
              maxLength={256}
              value={form.signingSecret}
              disabled={form.clearSecret}
              placeholder={
                form.saved?.signingSecretConfigured
                  ? '已配置，留空保留'
                  : '机器人启用签名校验时填写'
              }
              onChange={(event) => form.setSigningSecret(event.target.value)}
            />
          </label>
          {form.saved?.signingSecretConfigured && (
            <label className="notification-toggle">
              <input
                type="checkbox"
                checked={form.clearSecret}
                onChange={(event) => form.setClearSecret(event.target.checked)}
              />
              移除已保存的签名密钥
            </label>
          )}
          <label>
            监控台访问地址（可选）
            <input
              type="url"
              autoComplete="off"
              maxLength={2048}
              value={form.publicUrl}
              placeholder="https://codex.example.com/"
              onChange={(event) => form.setPublicUrl(event.target.value)}
            />
          </label>
          <p className="help">
            填写可从飞书/Lark 访问的监控台地址后，通知会附上会话链接。Webhook 和密钥仅保存在
            Server。
          </p>
          <div className="notification-actions">
            <button className="primary" disabled={!form.dirty}>
              {form.pending === 'save' ? '正在保存…' : '保存通知配置'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={form.dirty || !form.saved?.webhookConfigured}
              onClick={() => void form.sendTest()}
            >
              <Send size={13} />
              {form.pending === 'test' ? '正在发送…' : '发送测试通知'}
            </button>
          </div>
          {form.dirty && <p className="help">配置有未保存的修改，请先保存再发送测试通知。</p>}
        </fieldset>
      </form>
      <div className="notification-history" aria-label="最近通知记录">
        <h4>
          最近通知记录<span>最多显示 20 条</span>
        </h4>
        {!form.deliveries.length && <p className="help">暂无投递记录</p>}
        {form.deliveries.map((delivery) => (
          <div className="notification-delivery" key={delivery.id}>
            <div>
              <strong>{delivery.title}</strong>
              {delivery.workspaceName && <small>{delivery.workspaceName}</small>}
              <small>
                {delivery.kind === 'test'
                  ? '测试通知'
                  : delivery.kind === 'session.input_required'
                    ? '需要回复'
                    : '会话完成'}{' '}
                · {new Date(delivery.createdAt).toLocaleString('zh-CN')} · 尝试 {delivery.attempts}{' '}
                次
              </small>
              {delivery.error && <small className="notification-error">{delivery.error}</small>}
            </div>
            <span className={`notification-status ${delivery.status}`}>
              {deliveryStatus(delivery)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
