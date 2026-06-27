using Qomicex.Launcher.Backend.Models;

namespace Qomicex.Launcher.Backend.Services;

public interface IInstanceRepository
{
    List<GameInstance> GetAll();
    GameInstance? GetById(string id);
    GameInstance? GetDefault();
    GameInstance Create(GameInstance instance);
    GameInstance? Update(string id, GameInstance instance);
    bool Delete(string id);
}
