export interface HistoryPoint {
    date: string;
    bytes: number;
    uploads: number;
}
export interface PendingDevice {
    id: string;
    deviceName: string;
    githubLogin: string;
    createdAt: string;
}
export interface Device {
    id: string;
    deviceName: string;
    githubLogin: string;
    createdAt: string;
    lastUsedAt?: string;
    bytes: number;
    uploads: number;
}
export interface DashboardData {
    generatedAt: string;
    status: { activeUploads: number; concurrentUploadLimit: number };
    stats: {
        registeredDevices: number;
        activeDevices: number;
        totalUploads: number;
        totalBytes: number;
        todayUploads: number;
        todayBytes: number;
        dailyByteCapacity: number;
        dailyUploadCapacity: number;
        storedMediaBytes: number;
    };
    history: HistoryPoint[];
    pending: PendingDevice[];
    devices: Device[];
}

export async function getDashboard(): Promise<DashboardData> {
    const response = await fetch('/v1/admin/overview');
    if (response.status === 401) {
        throw new Error('unauthorized');
    }
    if (!response.ok) {
        throw new Error('Dashboard data is unavailable');
    }
    return await (response.json() as Promise<DashboardData>);
}

export async function mutateDashboard(path: string): Promise<void> {
    const response = await fetch(path, { method: 'POST' });
    if (!response.ok) {
        throw new Error('The action could not be completed');
    }
}
