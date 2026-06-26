using Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.Modrinth;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.Modrinth
{
    public class DataPacks : ModrinthSourceBase
    {
        protected override string ProjectType => ModrinthBase.ProjectType.Datapack;
    }
}
