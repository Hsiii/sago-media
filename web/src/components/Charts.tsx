import type { JSX } from 'react';

import type { HistoryPoint } from '../api.js';
import { formatBytes, shortDate } from '../format.js';

interface ChartProps {
    history: HistoryPoint[];
}

export function BandwidthChart({ history }: ChartProps): JSX.Element {
    const max = Math.max(...history.map((point) => point.bytes), 1);
    const points = history.map((point, index) => ({
        x: (index / Math.max(1, history.length - 1)) * 600,
        y: 156 - (point.bytes / max) * 132,
    }));
    const line = points
        .map(
            (point, index) =>
                `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
        )
        .join(' ');
    const total = history.reduce((sum, point) => sum + point.bytes, 0);

    return (
        <section className='card bandwidth-card'>
            <header className='card__header'>
                <div>
                    <h2>Bandwidth</h2>
                    <p>Transferred across all devices</p>
                </div>
                <span className='legend'>
                    <span className='legend__dot' /> Transfer
                </span>
            </header>
            <div className='chart-body'>
                <div className='chart-summary'>
                    <strong>{formatBytes(total)}</strong>
                    <span>last 14 days</span>
                </div>
                <svg
                    aria-label='Bandwidth transfer over the last 14 days'
                    className='line-chart'
                    preserveAspectRatio='none'
                    role='img'
                    viewBox='0 0 600 168'
                >
                    <defs>
                        <linearGradient
                            id='area-gradient'
                            x1='0'
                            x2='0'
                            y1='0'
                            y2='1'
                        >
                            <stop
                                offset='0'
                                stopColor='currentColor'
                                stopOpacity='.12'
                            />
                            <stop
                                offset='1'
                                stopColor='currentColor'
                                stopOpacity='0'
                            />
                        </linearGradient>
                    </defs>
                    <path
                        className='chart-grid'
                        d='M0 24H600M0 68H600M0 112H600M0 156H600'
                    />
                    <path
                        className='chart-area'
                        d={`${line} L600 156 L0 156 Z`}
                    />
                    <path className='chart-line' d={line} />
                    {points.map((point, index) => (
                        <circle
                            className='chart-point'
                            cx={point.x}
                            cy={point.y}
                            key={history[index]?.date}
                            r='3'
                        />
                    ))}
                </svg>
                <div className='chart-axis'>
                    <span>{shortDate(history[0]?.date ?? '')}</span>
                    <span>{shortDate(history[6]?.date ?? '')}</span>
                    <span>{shortDate(history.at(-1)?.date ?? '')}</span>
                </div>
            </div>
        </section>
    );
}

export function UploadChart({ history }: ChartProps): JSX.Element {
    const max = Math.max(...history.map((point) => point.uploads), 1);
    const total = history.reduce((sum, point) => sum + point.uploads, 0);
    return (
        <section className='card'>
            <header className='card__header'>
                <div>
                    <h2>Upload activity</h2>
                    <p>Requests processed each day</p>
                </div>
                <span className='pill'>14d</span>
            </header>
            <div className='chart-body'>
                <div className='chart-summary'>
                    <strong>{total.toLocaleString('en')}</strong>
                    <span>uploads</span>
                </div>
                <div
                    aria-label='Daily uploads over 14 days'
                    className='bar-chart'
                >
                    {history.map((point) => (
                        <div
                            className='bar-chart__column'
                            key={point.date}
                            title={`${point.date}: ${point.uploads} uploads`}
                        >
                            <span
                                style={{
                                    height: `${Math.max(2, (point.uploads / max) * 100)}%`,
                                }}
                            />
                        </div>
                    ))}
                </div>
                <div className='chart-axis'>
                    <span>{shortDate(history[0]?.date ?? '')}</span>
                    <span>Today</span>
                </div>
            </div>
        </section>
    );
}
