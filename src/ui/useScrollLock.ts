import {useEffect} from 'react';
const holders=new Set<symbol>();let previous='';
/** Locks compose across drawers and alerts, regardless of their close order. */
export function useScrollLock(active:boolean){useEffect(()=>{if(!active)return;const key=Symbol();if(!holders.size)previous=document.body.style.overflow;holders.add(key);document.body.style.overflow='hidden';return()=>{holders.delete(key);if(!holders.size)document.body.style.overflow=previous;};},[active]);}
