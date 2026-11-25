"use client"
import { logout } from '@/lib/actions/auth_action';
import type { ReactNode } from 'react';

import Image from 'next/image';

import { UserIcon } from 'lucide-react';
import { LogOutIcon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from '@radix-ui/react-dropdown-menu';

import { ChevronDown } from 'lucide-react';
import { clearPaginationSession } from "@/components/pagination/use-pagination-state";
import { useStore } from '@/lib/store';


export default function Topbar({ userName, mobileJornada }: { userName: string; mobileJornada: ReactNode }) {
  const resetOperatorState = useStore((state) => state.reset);
  const switchOperator = async () => {
    resetOperatorState();
    try { sessionStorage.clear(); } catch { /* Storage may be unavailable. */ }
    clearPaginationSession();
    await logout();
  };
  const logoutItem = (
    <DropdownMenuItem onSelect={() => switchOperator()} className='flex items-center justify-start gap-3 px-2 flex-row outline-0 h-10 hover:bg-gray-100 data-highlighted:bg-gray-100 rounded-sm cursor-pointer'>
      <div className='flex items-center justify-center w-6 h-6'>
        <LogOutIcon aria-hidden='true' className='w-4 h-4' />
      </div>
      <div className='truncate text-sm'>
        <span>Cambiar operador / salir</span>
      </div>
    </DropdownMenuItem>
  );

  return (
    <div className='z-20 flex flex-row justify-between h-16 lg:h-20 w-full bg-white font-rounded shadow-sm'>
      <div className='flex flex-row text-2xl lg:text-4xl font-extrabold text-gray-900 '>
        <Image className='m-4 lg:m-5 w-8 h-8 lg:w-10 lg:h-10' width="50" height="50" src="/icon.svg" alt='Comal Core logo' />
        <h1 className='flex items-center justify-center '>Comal&nbsp;<span className='text-orange-500'>Core</span></h1>
      </div>
      <div className='mr-3 flex items-center lg:hidden'>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label='Menú de usuario' className='flex min-h-11 items-center gap-1 rounded-md focus-visible:outline-2'>
            <span className='flex size-9 items-center justify-center rounded-full bg-amber-300'>
              <UserIcon aria-hidden='true' className='size-5' />
            </span>
            <ChevronDown aria-hidden='true' className='size-4' />
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent align='end' sideOffset={8} className='z-50 min-w-44 max-w-[calc(100vw-1.5rem)] rounded-md border border-gray-100 bg-white p-1 font-rounded shadow-lg'>
              {mobileJornada}
              {logoutItem}
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
      </div>
      <div className='hidden items-center justify-around w-fit cursor-pointer lg:flex lg:m-5'>
        <DropdownMenu >
          <DropdownMenuTrigger className='flex gap-2 w-fit h-10 items-center justify-around bg-white cursor-pointer outline-0 '>
            <div className='flex shrink-0 items-center justify-center rounded-full w-9 h-9 outline-0 bg-amber-300'>
              <UserIcon className='w-5 h-5' />
            </div>
            <div className='flex items-center justify-center'>
              <span className='hidden lg:inline'>{userName}</span> <ChevronDown className='m-1' />
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='z-20 flex flex-col min-w-40 w-[--radix-dropdown-menu-trigger-width] mt-2 bg-white shadow-lg rounded-md border border-gray-100 p-1'>
            {logoutItem}

          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    </div>
  );
}
