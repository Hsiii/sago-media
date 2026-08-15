import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getDashboard, mutateDashboard } from '../api.js';
import { Capacity } from './Capacity.js';
import { BandwidthChart, UploadChart } from './Charts.js';
import { Devices } from './Devices.js';
import { Metrics } from './Metrics.js';
import { Sidebar } from './Sidebar.js';

import './dashboard.css';

function LoadingDashboard(): JSX.Element {
    return (
        <main aria-label='Loading dashboard' className='loading'>
            <div className='loading__heading skeleton' />
            <div className='loading__metrics skeleton' />
            <div className='loading__grid'>
                <div className='loading__chart skeleton' />
                <div className='loading__chart skeleton' />
            </div>
        </main>
    );
}

export function App(): JSX.Element {
    const queryClient = useQueryClient();
    const dashboard = useQuery({
        queryKey: ['dashboard'],
        queryFn: getDashboard,
        refetchInterval: 30_000,
        retry: false,
    });
    const action = useMutation({
        mutationFn: mutateDashboard,
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        },
    });

    if (dashboard.isPending) {
        return <LoadingDashboard />;
    }
    if (dashboard.isError) {
        const unauthorized = dashboard.error.message === 'unauthorized';
        return (
            <main className='error-page'>
                <span className='brand-mark'>SM</span>
                <h1>
                    {unauthorized
                        ? 'Your session expired'
                        : 'Dashboard unavailable'}
                </h1>
                <p>
                    {unauthorized
                        ? 'Sign in again to continue managing Sago Media.'
                        : 'The server could not load dashboard data. Try again shortly.'}
                </p>
                {unauthorized ? (
                    <a className='button' href='/admin/login'>
                        Continue with GitHub
                    </a>
                ) : (
                    <button
                        onClick={() => {
                            dashboard.refetch().catch(() => undefined);
                        }}
                        type='button'
                    >
                        Try again
                    </button>
                )}
            </main>
        );
    }

    const { data } = dashboard;
    const updatedAt = new Intl.DateTimeFormat('en', {
        hour: 'numeric',
        minute: '2-digit',
    }).format(new Date(data.generatedAt));

    return (
        <div className='shell'>
            <Sidebar concurrentLimit={data.status.concurrentUploadLimit} />
            <header className='topbar'>
                <strong>Sago Media</strong>
                <span>Overview</span>
                <span className='topbar__status'>
                    <span className='status-dot' /> All systems operational
                </span>
            </header>
            <main className='page'>
                <header className='page-heading' id='overview'>
                    <div>
                        <h1>Usage overview</h1>
                        <p>
                            Monitor media delivery, capacity, and connected
                            devices.
                        </p>
                    </div>
                    <span>Last updated {updatedAt}</span>
                </header>
                <Metrics data={data} />
                <div className='dashboard-grid' id='usage'>
                    <BandwidthChart history={data.history} />
                    <div className='dashboard-stack'>
                        <UploadChart history={data.history} />
                        <Capacity data={data} />
                    </div>
                </div>
                {action.isError ? (
                    <p className='action-error' role='alert'>
                        {action.error.message}
                    </p>
                ) : undefined}
                <Devices
                    data={data}
                    onAction={(path) => {
                        action.mutate(path);
                    }}
                    pendingAction={
                        action.isPending ? action.variables : undefined
                    }
                />
            </main>
        </div>
    );
}
