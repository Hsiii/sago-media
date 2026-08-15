import type { JSX } from 'react';
import { Inbox, Monitor } from 'lucide-react';

import type { DashboardData, Device, PendingDevice } from '../api.js';
import { formatBytes, relativeTime } from '../format.js';

interface DevicesProps {
    data: DashboardData;
    pendingAction?: string;
    onAction: (path: string) => void;
}

function PendingRow({
    device,
    pendingAction,
    onAction,
}: {
    device: PendingDevice;
    pendingAction?: string;
    onAction: (path: string) => void;
}): JSX.Element {
    const approvePath = `/v1/admin/requests/${device.id}/approve`;
    const denyPath = `/v1/admin/requests/${device.id}/deny`;
    return (
        <div className='pending-row'>
            <span className='device-icon'>
                <Monitor aria-hidden='true' />
            </span>
            <div className='pending-row__info'>
                <strong>{device.githubLogin}</strong>
                <span>
                    {device.deviceName} / requested{' '}
                    {relativeTime(device.createdAt)}
                </span>
            </div>
            <div className='actions'>
                <button
                    disabled={pendingAction !== undefined}
                    onClick={() => {
                        onAction(approvePath);
                    }}
                    type='button'
                >
                    {pendingAction === approvePath ? 'Approving...' : 'Approve'}
                </button>
                <button
                    className='button button--secondary button--danger'
                    disabled={pendingAction !== undefined}
                    onClick={() => {
                        onAction(denyPath);
                    }}
                    type='button'
                >
                    {pendingAction === denyPath ? 'Denying...' : 'Deny'}
                </button>
            </div>
        </div>
    );
}

function DeviceRow({
    device,
    pendingAction,
    onAction,
}: {
    device: Device;
    pendingAction?: string;
    onAction: (path: string) => void;
}): JSX.Element {
    const revokePath = `/v1/admin/credentials/${device.id}/revoke`;
    const scopePath = (scope: Device['scope']): string =>
        `/v1/admin/credentials/${device.id}/scope/${scope}`;
    const active =
        device.lastUsedAt !== undefined &&
        Date.now() - new Date(device.lastUsedAt).getTime() < 7 * 86_400_000;
    return (
        <tr>
            <td>
                <div className='device-name'>
                    <span className='device-icon'>
                        <Monitor aria-hidden='true' />
                    </span>
                    <div>
                        <strong>{device.deviceName}</strong>
                        <span>Added {relativeTime(device.createdAt)}</span>
                    </div>
                </div>
            </td>
            <td>
                <strong>@{device.githubLogin}</strong>
                <span>
                    {device.scope === 'upload:any'
                        ? 'Full access'
                        : 'PR access'}
                </span>
            </td>
            <td>
                <select
                    aria-label={`Scope for ${device.deviceName}`}
                    className='scope-select'
                    disabled={pendingAction !== undefined}
                    onChange={(event) => {
                        onAction(
                            scopePath(event.target.value as Device['scope'])
                        );
                    }}
                    value={device.scope}
                >
                    <option value='upload:pr'>upload:pr</option>
                    <option value='upload:any'>upload:any</option>
                </select>
            </td>
            <td className='optional-column'>
                <strong>{device.uploads.toLocaleString('en')}</strong>
                <span>{formatBytes(device.bytes)} / 14d</span>
            </td>
            <td>
                <span className='last-seen'>
                    <span
                        className={`status-dot ${active ? '' : 'status-dot--idle'}`}
                    />
                    {relativeTime(device.lastUsedAt)}
                </span>
            </td>
            <td className='table-action'>
                <button
                    aria-label={`Revoke ${device.deviceName}`}
                    className='button button--secondary button--danger'
                    disabled={pendingAction !== undefined}
                    onClick={() => {
                        onAction(revokePath);
                    }}
                    type='button'
                >
                    {pendingAction === revokePath ? 'Revoking...' : 'Revoke'}
                </button>
            </td>
        </tr>
    );
}

export function Devices({
    data,
    pendingAction,
    onAction,
}: DevicesProps): JSX.Element {
    return (
        <>
            <section className='section'>
                <h2 className='section__title'>
                    Pending access{' '}
                    <span className='pill'>{data.pending.length}</span>
                </h2>
                <div className='card'>
                    {data.pending.length === 0 ? (
                        <div className='empty-state'>
                            <Inbox aria-hidden='true' />
                            <strong>No pending requests</strong>
                            <span>
                                New device access requests will appear here.
                            </span>
                        </div>
                    ) : (
                        data.pending.map((device) => (
                            <PendingRow
                                device={device}
                                key={device.id}
                                onAction={onAction}
                                pendingAction={pendingAction}
                            />
                        ))
                    )}
                </div>
            </section>
            <section className='section' id='devices'>
                <h2 className='section__title'>
                    Registered devices{' '}
                    <span className='pill'>{data.devices.length}</span>
                </h2>
                <div className='card table-wrap'>
                    <table>
                        <thead>
                            <tr>
                                <th>Device</th>
                                <th>Account</th>
                                <th>Scope</th>
                                <th className='optional-column'>Usage</th>
                                <th>Last seen</th>
                                <th>
                                    <span className='visually-hidden'>
                                        Actions
                                    </span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.devices.map((device) => (
                                <DeviceRow
                                    device={device}
                                    key={device.id}
                                    onAction={onAction}
                                    pendingAction={pendingAction}
                                />
                            ))}
                        </tbody>
                    </table>
                    {data.devices.length === 0 ? (
                        <div className='empty-state'>
                            <Monitor aria-hidden='true' />
                            <strong>No registered devices</strong>
                            <span>Approved devices will appear here.</span>
                        </div>
                    ) : undefined}
                </div>
                <p className='footnote'>
                    Usage is aggregated over the last 14 days / Quotas reset
                    daily at 00:00 UTC
                </p>
            </section>
        </>
    );
}
