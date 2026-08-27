import { cn } from '../lib/cn.js'

interface SkeletonProps {
  className?: string
}

function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-xl bg-muted',
        className
      )}
    />
  )
}

interface SkeletonCardProps {
  className?: string
  lines?: number
  avatar?: boolean
}

function SkeletonCard({ className, lines = 3, avatar = false }: SkeletonCardProps) {
  return (
    <div className={cn('rounded-xl border bg-card p-5', className)}>
      {avatar && (
        <div className="mb-3 flex justify-center">
          <Skeleton className="h-16 w-16 rounded-2xl" />
        </div>
      )}
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4 mx-auto" />
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            key={i}
            className={cn(
              'h-3',
              i === lines - 1 ? 'w-1/2 mx-auto' : 'w-full'
            )}
          />
        ))}
      </div>
    </div>
  )
}

interface SkeletonListProps {
  count?: number
  className?: string
}

function SkeletonList({ count = 3, className }: SkeletonListProps) {
  return (
    <div className={cn('space-y-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border bg-card p-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export { Skeleton, SkeletonCard, SkeletonList }
