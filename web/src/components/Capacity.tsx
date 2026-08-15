import type { JSX } from 'react';

import type { DashboardData } from '../api.js';
import { formatBytes, percent } from '../format.js';

interface CapacityProps {
    data: DashboardData;
}

function Meter({ value }: { value: number }): JSX.Element {
    return (
        <div aria-hidden='true' className='meter'>
            <span style={{ width: `${value}%` }} />
        </div>
    );
}

export function Capacity({ data }: CapacityProps): JSX.Element {
    const { status, stats } = data;
    const bandwidth = percent(stats.todayBytes, stats.dailyByteCapacity);
    return (
        <section className='card'>
            <header className='card__header'>
                <div>
                    <h2>Capacity</h2>
                    <p>Current service limits</p>
                </div>
                <span className='pill'>Live</span>
            </header>
            <div className='capacity'>
                <strong className='capacity__value'>
                    {formatBytes(stats.todayBytes)}
                </strong>
                <p>
                    of {formatBytes(stats.dailyByteCapacity)} daily bandwidth
                    used
                </p>
                <Meter value={bandwidth} />
                <div className='capacity__key'>
                    <span>{bandwidth.toFixed(1)}% used</span>
                    <span>
                        {formatBytes(
                            Math.max(
                                0,
                                stats.dailyByteCapacity - stats.todayBytes
                            )
                        )}{' '}
                        remaining
                    </span>
                </div>
                <div className='quota-list'>
                    <div className='quota'>
                        <span>Upload requests</span>
                        <strong>
                            {stats.todayUploads} / {stats.dailyUploadCapacity}
                        </strong>
                        <Meter
                            value={percent(
                                stats.todayUploads,
                                stats.dailyUploadCapacity
                            )}
                        />
                    </div>
                    <div className='quota'>
                        <span>Concurrent uploads</span>
                        <strong>
                            {status.activeUploads} /{' '}
                            {status.concurrentUploadLimit}
                        </strong>
                        <Meter
                            value={percent(
                                status.activeUploads,
                                status.concurrentUploadLimit
                            )}
                        />
                    </div>
                </div>
            </div>
        </section>
    );
}
