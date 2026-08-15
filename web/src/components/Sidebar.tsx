import type { JSX } from 'react';
import { Activity, Database, LayoutDashboard, Monitor } from 'lucide-react';

interface SidebarProps {
    concurrentLimit: number;
}

export function Sidebar({ concurrentLimit }: SidebarProps): JSX.Element {
    return (
        <aside className='sidebar'>
            <div className='sidebar__team'>
                <span className='brand-mark'>SM</span>
                <span>Sago Media</span>
            </div>
            <nav aria-label='Dashboard' className='sidebar__nav'>
                <a className='nav-link nav-link--active' href='#overview'>
                    <LayoutDashboard aria-hidden='true' /> Overview
                </a>
                <a className='nav-link' href='#usage'>
                    <Database aria-hidden='true' /> Usage
                </a>
                <a className='nav-link' href='#devices'>
                    <Monitor aria-hidden='true' /> Devices
                </a>
            </nav>
            <p className='sidebar__label'>Service</p>
            <nav className='sidebar__nav sidebar__nav--secondary'>
                <a className='nav-link' href='/health'>
                    <Activity aria-hidden='true' /> Health
                </a>
            </nav>
            <div className='service-status'>
                <strong>
                    <span className='status-dot' /> Operational
                </strong>
                <span>{concurrentLimit} concurrent upload slots</span>
            </div>
        </aside>
    );
}
