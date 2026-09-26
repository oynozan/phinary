import type { Metadata } from 'next';
import { VaultView } from '@/components/vault/vault-view';
export const metadata:Metadata={title:'Vault'};
export default function Page(){return <VaultView/>;}
