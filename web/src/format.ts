export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const unit = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1000)),
        units.length - 1
    );
    const value = bytes / 1000 ** unit;
    return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function relativeTime(value?: string): string {
    if (value === undefined) {
        return 'Never';
    }
    const elapsed = Date.now() - new Date(value).getTime();
    if (elapsed < 60_000) {
        return 'Just now';
    }
    if (elapsed < 3_600_000) {
        return `${Math.floor(elapsed / 60_000)}m ago`;
    }
    if (elapsed < 86_400_000) {
        return `${Math.floor(elapsed / 3_600_000)}h ago`;
    }
    if (elapsed < 604_800_000) {
        return `${Math.floor(elapsed / 86_400_000)}d ago`;
    }
    return new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
    }).format(new Date(value));
}

export function shortDate(value: string): string {
    return new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    }).format(new Date(`${value}T00:00:00Z`));
}

export function percent(value: number, total: number): number {
    return total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
}
