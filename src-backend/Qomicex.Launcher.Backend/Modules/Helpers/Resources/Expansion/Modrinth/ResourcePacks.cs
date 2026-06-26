using Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.Modrinth;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.Modrinth
{
    public class ResourcePacks : ModrinthSourceBase
    {
        protected override string ProjectType => ModrinthBase.ProjectType.ResourcePack;
    }
}
