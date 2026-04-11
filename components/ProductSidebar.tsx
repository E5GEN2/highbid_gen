'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AuthButton from './AuthButton';
import { ApiTokenPopover } from './ApiTokenPopover';

export interface NavItem {
  label: string;
  href: string;
  icon?: React.ReactNode;
  children?: NavItem[];
  /** If true, children are injected at runtime (e.g. after selecting a niche) */
  dynamicChildren?: boolean;
  /** Dynamic children passed in at runtime */
  activeChildren?: NavItem[];
  /** Label shown above dynamic children (e.g. the selected keyword) */
  activeLabel?: string;
}

export interface ProductSidebarProps {
  productName?: string;
  productIcon?: React.ReactNode;
  accentColor?: string;
  navItems: NavItem[];
  backHref?: string;
  showApiToken?: boolean;
  /** For mobile: allow collapsing */
  collapsible?: boolean;
}

export default function ProductSidebar({
  productName,
  productIcon,
  accentColor = 'white',
  navItems,
  backHref = '/',
  showApiToken = false,
  collapsible = false,
}: ProductSidebarProps) {
  const pathname = usePathname();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleExpand = (label: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const isActive = (href: string) => {
    if (href === pathname) return true;
    // For product root, only exact match
    if (href.split('/').length <= 3) return pathname === href;
    // For deeper routes, check prefix
    return pathname.startsWith(href);
  };

  const isParentActive = (item: NavItem) => {
    if (isActive(item.href)) return true;
    if (item.children?.some(c => isActive(c.href))) return true;
    if (item.activeChildren?.some(c => isActive(c.href))) return true;
    return false;
  };

  // Auto-expand items that have active children
  React.useEffect(() => {
    navItems.forEach(item => {
      if (isParentActive(item) && (item.children?.length || item.activeChildren?.length)) {
        setExpandedItems(prev => new Set([...prev, item.label]));
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const renderNavItem = (item: NavItem, depth = 0) => {
    const hasChildren = (item.children && item.children.length > 0) || (item.activeChildren && item.activeChildren.length > 0);
    const isExpanded = expandedItems.has(item.label) || isParentActive(item);
    const active = isActive(item.href);

    return (
      <div key={item.label}>
        {/* Parent item */}
        <div className="flex items-center">
          {hasChildren ? (
            <button
              onClick={() => toggleExpand(item.label)}
              className={`flex-1 flex items-center gap-3 py-2.5 px-4 mx-2 rounded-lg text-sm transition-colors ${
                isParentActive(item)
                  ? 'text-white bg-white/10'
                  : 'text-[#888] hover:bg-white/5 hover:text-white'
              }`}
            >
              {item.icon && <span className="w-5 h-5 flex-shrink-0">{item.icon}</span>}
              <span className="flex-1 text-left">{item.label}</span>
              <svg
                className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          ) : (
            <Link
              href={item.href}
              className={`flex-1 flex items-center gap-3 py-2.5 px-4 mx-2 rounded-lg text-sm transition-colors ${
                active
                  ? 'text-white bg-white/10'
                  : 'text-[#888] hover:bg-white/5 hover:text-white'
              }`}
            >
              {item.icon && <span className="w-5 h-5 flex-shrink-0">{item.icon}</span>}
              <span>{item.label}</span>
            </Link>
          )}
        </div>

        {/* Children (static or dynamic) */}
        {hasChildren && isExpanded && (
          <div className="mt-0.5 mb-1">
            {/* Dynamic label (e.g. selected keyword name) */}
            {item.activeLabel && (
              <div className="pl-12 pr-4 py-1.5 text-xs text-[#666] font-medium truncate">
                {item.activeLabel}
              </div>
            )}
            {/* Static children */}
            {item.children?.map(child => (
              <Link
                key={child.label}
                href={child.href}
                className={`block pl-12 pr-4 py-2 text-sm transition-colors ${
                  isActive(child.href)
                    ? 'text-white bg-white/[0.08] border-l-2 border-white ml-2 pl-10'
                    : 'text-[#888] hover:text-white'
                }`}
              >
                {child.label}
              </Link>
            ))}
            {/* Dynamic children (injected at runtime) */}
            {item.activeChildren?.map(child => (
              <Link
                key={child.label}
                href={child.href}
                className={`block pl-12 pr-4 py-2 text-sm transition-colors ${
                  isActive(child.href)
                    ? 'text-white bg-white/[0.08] border-l-2 border-white ml-2 pl-10'
                    : 'text-[#888] hover:text-white'
                }`}
              >
                {child.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  };

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="px-4 pt-5 pb-2">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-purple-600 to-pink-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
            H
          </div>
          <span className="text-white font-semibold text-base">rofe.ai</span>
        </Link>
      </div>

      {/* Back to Dashboard */}
      {backHref && productName && (
        <Link
          href={backHref}
          className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-white hover:bg-white/5 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Dashboard
        </Link>
      )}

      {/* Product name label */}
      {productName && (
        <div className="px-4 mt-4 mb-2 text-xs text-[#666] uppercase tracking-wider font-medium">
          {productName}
        </div>
      )}

      {/* Nav items */}
      <nav className="flex-1 py-2 space-y-0.5 overflow-y-auto">
        {navItems.map(item => renderNavItem(item))}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-[#1a1a1a] py-3 px-2 space-y-1">
        {showApiToken && <ApiTokenPopover />}
        <AuthButton variant="sidebar" />
      </div>
    </>
  );

  return (
    <>
      {/* Mobile toggle */}
      {collapsible && (
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="md:hidden fixed top-4 left-4 z-[60] w-10 h-10 bg-[#111] border border-[#1a1a1a] rounded-lg flex items-center justify-center text-white"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      {/* Sidebar */}
      <aside
        className={`w-60 bg-[#0f0f0f] border-r border-[#1a1a1a] flex flex-col fixed h-full z-50 transition-transform ${
          collapsible ? (mobileOpen ? 'translate-x-0' : 'max-md:-translate-x-full') : ''
        }`}
      >
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {collapsible && mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </>
  );
}
