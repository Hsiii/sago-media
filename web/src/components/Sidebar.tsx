import type { JSX } from 'react';
import { Database, LayoutDashboard, Monitor } from 'lucide-react';

export function Sidebar(): JSX.Element {
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
        </aside>
    );
}
