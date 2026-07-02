import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import * as accountApi from '../api/account.ts'
import type { Account } from '../types/index.ts'

interface UseRequireDefaultAccountReturn {
  needsAccount: boolean
  noAccounts: boolean
  hasDefault: boolean
  resolve: () => Promise<boolean>
  showNoAccount: boolean
  showSelectAccount: boolean
  handleAddAccount: () => void
  handleGoToAccounts: () => void
  handleCancelNoAccount: () => void
  handleCancelSelect: () => void
  handleSelectAccount: (account: Account) => void
}

export function useRequireDefaultAccount(): UseRequireDefaultAccountReturn {
  const navigate = useNavigate()
  const [showNoAccount, setShowNoAccount] = useState(false)
  const [showSelectAccount, setShowSelectAccount] = useState(false)
  const pendingResolveRef = useRef<((value: boolean) => void) | null>(null)

  const checkAndResolve = useCallback(async (): Promise<boolean> => {
    try {
      const accounts = await accountApi.getAccounts()
      if (accounts.length === 0) {
        setShowNoAccount(true)
        return new Promise<boolean>((r) => { pendingResolveRef.current = r })
      }
      const hasDefault = accounts.some(a => a.isDefault)
      if (!hasDefault) {
        setShowSelectAccount(true)
        return new Promise<boolean>((r) => { pendingResolveRef.current = r })
      }
      return true
    } catch {
      return true
    }
  }, [])

  const handleAddAccount = useCallback(() => {
    setShowNoAccount(false)
    navigate('/accounts')
    if (pendingResolveRef.current) {
      pendingResolveRef.current(false)
      pendingResolveRef.current = null
    }
  }, [navigate])

  const handleGoToAccounts = useCallback(() => {
    setShowNoAccount(false)
    navigate('/accounts')
    if (pendingResolveRef.current) {
      pendingResolveRef.current(false)
      pendingResolveRef.current = null
    }
  }, [navigate])

  const handleCancelNoAccount = useCallback(() => {
    setShowNoAccount(false)
    if (pendingResolveRef.current) {
      pendingResolveRef.current(false)
      pendingResolveRef.current = null
    }
  }, [])

  const handleCancelSelect = useCallback(() => {
    setShowSelectAccount(false)
    if (pendingResolveRef.current) {
      pendingResolveRef.current(false)
      pendingResolveRef.current = null
    }
  }, [])

  const handleSelectAccount = useCallback((_account: Account) => {
    setShowSelectAccount(false)
    if (pendingResolveRef.current) {
      pendingResolveRef.current(true)
      pendingResolveRef.current = null
    }
  }, [])

  return {
    needsAccount: true,
    noAccounts: showNoAccount,
    hasDefault: !showNoAccount && !showSelectAccount,
    resolve: checkAndResolve,
    showNoAccount,
    showSelectAccount,
    handleAddAccount,
    handleGoToAccounts,
    handleCancelNoAccount,
    handleCancelSelect,
    handleSelectAccount,
  }
}
