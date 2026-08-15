import type { JSX, ReactNode } from 'react';
import { Activity, Database, Monitor, Upload } from 'lucide-react';

import type { DashboardData } from '../api.js';
import { formatBytes, percent } from '../format.js';

interface MetricsProps {
    data: DashboardData;
}

interface MetricProps {
    title: string;
    value: string;
    note: string;
    icon: ReactNode;
    progress?: number;
}

function Metric({
    title,
    value,
    note,
    icon,
    progress,
}: MetricProps): JSX.Element {
    return (
        <article className='metric'>
            <header>
                <h3>{title}</h3>
                {icon}
            </header>
            <strong>{value}</strong>
            <p>{note}</p>
            {progress === undefined ? undefined : (
                <div aria-hidden='true' className='meter'>
                    <span style={{ width: `${progress}%` }} />
                </div>
            )}
        </article>
    );
}

export function Metrics({ data }: MetricsProps): JSX.Element {
    const { stats } = data;
    const deviceNote = `${stats.activeDevices} active in the last 7 days${stats.legacyDevices > 0 ? ` / ${stats.legacyDevices} legacy` : ''}`;
    return (
        <section aria-label='Key statistics' className='metrics'>
            <Metric
                icon={<Monitor aria-hidden='true' />}
                note={deviceNote}
                title='Registered devices'
                value={stats.registeredDevices.toLocaleString('en')}
            />
            <Metric
                icon={<Upload aria-hidden='true' />}
                note={`${stats.todayUploads.toLocaleString('en')} processed today`}
                title='Total uploads'
                value={stats.totalUploads.toLocaleString('en')}
            />
            <Metric
                icon={<Activity aria-hidden='true' />}
                note={`of ${formatBytes(stats.dailyByteCapacity)} combined allowance`}
                progress={percent(stats.todayBytes, stats.dailyByteCapacity)}
                title="Today's transfer"
                value={formatBytes(stats.todayBytes)}
            />
            <Metric
                icon={<Database aria-hidden='true' />}
                note='Actual files in the media store'
                title='Stored media'
                value={formatBytes(stats.storedMediaBytes)}
            />
        </section>
    );
}
