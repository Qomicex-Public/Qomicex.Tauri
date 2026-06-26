using Qomicex.Launcher.Backend.ModRecommenderModelLib.Models;

namespace Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;

public interface IUserBehaviorRepository
{
    Task AddAsync(UserBehavior behavior);

    Task AddRangeAsync(List<UserBehavior> behaviors);

    Task<List<UserBehavior>> GetByUserIdAsync(string userId);

    Task<List<UserBehavior>> GetByModIdAsync(int modId);

    Task<List<UserBehavior>> GetAllAsync();

    Task<int> GetCountAsync();

    Task<int> GetCountByUserAsync(string userId);

    Task SaveChangesAsync();

    Task<UserPreference> GetOrCreateUserPreferenceAsync(string userId);

    Task UpdateUserPreferenceAsync(UserPreference preference);
}
